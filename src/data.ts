/**
 * Locate the LexBG database, downloading the prebuilt one on first use.
 *
 * Resolution order:
 *   1. LEXBG_DB                     — explicit path (never downloads)
 *   2. <repo>/data/lexbg.db         — you built it yourself with `npm run build:db`
 *   3. ~/.lexbg/lexbg.db            — the weekly prebuilt database from GitHub Releases,
 *                                     downloaded on first start and refreshed in the background
 *
 * Environment: LEXBG_HOME (cache folder), LEXBG_DATA_URL (release base URL),
 * LEXBG_OFFLINE=1 (never touch the network).
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { SCHEMA_VERSION } from './db.js';
import { findRoot } from './registry.js';

export const DEFAULT_DATA_URL = 'https://github.com/StanK1/lexbg-mcp/releases/download/data';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface Manifest {
  format: number;
  schema_version: string;
  built_at: string;
  sha256: string;
  gz_sha256: string;
  gz_bytes: number;
}

interface LocalState extends Manifest {
  checked_at?: string;
}

export interface ResolvedDb {
  file: string;
  source: 'env' | 'repo' | 'cache' | 'downloaded';
  /** Resolves when a background update check finishes (for tests / logging). */
  update?: Promise<string>;
}

const log = (msg: string) => console.error(`[lexbg] ${msg}`);
const sha256 = (buf: Buffer) => crypto.createHash('sha256').update(buf).digest('hex');

export function cacheDir(): string {
  return path.resolve(process.env.LEXBG_HOME ?? path.join(os.homedir(), '.lexbg'));
}

function dataUrl(): string {
  return (process.env.LEXBG_DATA_URL ?? DEFAULT_DATA_URL).replace(/\/$/, '');
}

async function fetchBuffer(url: string, timeoutMs: number): Promise<Buffer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': 'LexBG' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function fetchManifest(): Promise<Manifest> {
  const m = JSON.parse((await fetchBuffer(`${dataUrl()}/lexbg-manifest.json`, 20000)).toString('utf8')) as Manifest;
  if (!m.sha256 || !m.built_at) throw new Error('invalid manifest');
  return m;
}

function readState(dir: string): LocalState | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'lexbg-manifest.json'), 'utf8')) as LocalState;
  } catch {
    return null;
  }
}

function writeState(dir: string, state: LocalState): void {
  fs.writeFileSync(path.join(dir, 'lexbg-manifest.json'), JSON.stringify(state, null, 2));
}

/** Download, verify (both checksums) and atomically install the database at `target`. */
async function download(manifest: Manifest, target: string): Promise<void> {
  const started = Date.now();
  const gz = await fetchBuffer(`${dataUrl()}/lexbg.db.gz`, 5 * 60 * 1000);
  if (sha256(gz) !== manifest.gz_sha256) throw new Error('checksum mismatch on lexbg.db.gz — try again');
  const db = zlib.gunzipSync(gz);
  if (sha256(db) !== manifest.sha256) throw new Error('checksum mismatch on lexbg.db — try again');
  const tmp = `${target}.download`;
  fs.writeFileSync(tmp, db);
  try {
    fs.renameSync(tmp, target);
  } catch {
    // Windows cannot replace a file that is open; install it on the next start instead.
    fs.renameSync(tmp, `${target}.next`);
  }
  log(`database ${manifest.built_at} installed (${(gz.length / 1024 / 1024).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(1)} s)`);
}

async function checkForUpdate(dir: string, target: string): Promise<string> {
  const state = readState(dir);
  if (state?.checked_at && Date.now() - Date.parse(state.checked_at) < CHECK_INTERVAL_MS) return 'checked recently';
  const remote = await fetchManifest();
  const now = new Date().toISOString();
  if (remote.schema_version !== SCHEMA_VERSION) {
    writeState(dir, { ...(state ?? remote), checked_at: now });
    return `newer database needs a newer LexBG version (schema ${remote.schema_version})`;
  }
  if (state && state.sha256 === remote.sha256) {
    writeState(dir, { ...state, checked_at: now });
    return 'up to date';
  }
  await download(remote, target);
  writeState(dir, { ...remote, checked_at: now });
  return `updated to ${remote.built_at}`;
}

export async function resolveDatabase(opts: { useRepoDb?: boolean } = {}): Promise<ResolvedDb> {
  if (process.env.LEXBG_DB) return { file: path.resolve(process.env.LEXBG_DB), source: 'env' };

  if (opts.useRepoDb !== false) {
    try {
      const repoDb = path.join(findRoot(), 'data', 'lexbg.db');
      if (fs.existsSync(repoDb)) return { file: repoDb, source: 'repo' };
    } catch {
      // not running from a checkout — fine
    }
  }

  const dir = cacheDir();
  const target = path.join(dir, 'lexbg.db');
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(`${target}.next`)) {
    try { fs.renameSync(`${target}.next`, target); } catch { /* keep the current one */ }
  }

  const offline = process.env.LEXBG_OFFLINE === '1';
  if (fs.existsSync(target)) {
    const update = offline
      ? Promise.resolve('offline')
      : checkForUpdate(dir, target).catch(err => `update check failed: ${(err as Error).message}`);
    void update.then(msg => log(msg));
    return { file: target, source: 'cache', update };
  }

  if (offline) throw new Error(`No database at ${target} and LEXBG_OFFLINE=1. Build one with "npm run build:db" or unset LEXBG_OFFLINE.`);
  log(`first start — downloading the LexBG database to ${dir} ...`);
  const manifest = await fetchManifest();
  if (manifest.schema_version !== SCHEMA_VERSION) {
    throw new Error(`The published database (schema ${manifest.schema_version}) needs a newer LexBG version. Update LexBG.`);
  }
  await download(manifest, target);
  writeState(dir, { ...manifest, checked_at: new Date().toISOString() });
  return { file: target, source: 'downloaded' };
}
