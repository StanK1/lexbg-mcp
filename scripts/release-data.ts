#!/usr/bin/env tsx
/**
 * Package data/lexbg.db for distribution: release/lexbg.db.gz + release/lexbg-manifest.json
 * (+ coverage report and release notes). Used by .github/workflows/data.yml.
 *
 *   npm run release:data
 */
import '../src/quiet.js';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { defaultDbPath, getMeta, openDb } from '../src/db.js';
import { getCoverage } from '../src/coverage.js';
import { ROOT } from './lib/paths.js';

export interface DataManifest {
  format: 1;
  schema_version: string;
  built_at: string;
  latest_act_date: string | null;
  sha256: string;          // of the uncompressed lexbg.db
  bytes: number;
  gz_sha256: string;
  gz_bytes: number;
  laws: { tracked: number; consolidated: number; original: number; missing: number };
  eu_acts_with_text: number;
  acts: number;
  provisions: number;
  commit: string | null;
}

const sha256 = (buf: Buffer) => crypto.createHash('sha256').update(buf).digest('hex');

function main(): void {
  const dbFile = defaultDbPath();
  const out = path.join(ROOT, 'release');
  fs.mkdirSync(out, { recursive: true });

  const db = openDb(dbFile, { readOnly: true });
  const cov = getCoverage(db);
  const bg = cov.filter(c => c.kind === 'bg');
  const n = (s: string) => bg.filter(c => c.text_status === s).length;
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const raw = fs.readFileSync(dbFile);
  const gz = zlib.gzipSync(raw, { level: 9 });

  const manifest: DataManifest = {
    format: 1,
    schema_version: getMeta(db, 'schema_version') ?? '1',
    built_at: getMeta(db, 'built_at') ?? new Date().toISOString(),
    latest_act_date: getMeta(db, 'latest_act_date') || null,
    sha256: sha256(raw),
    bytes: raw.length,
    gz_sha256: sha256(gz),
    gz_bytes: gz.length,
    laws: { tracked: bg.length, consolidated: n('consolidated'), original: n('original'), missing: n('missing') },
    eu_acts_with_text: cov.filter(c => c.kind === 'eu' && c.text_status !== 'missing').length,
    acts: count('SELECT COUNT(*) AS n FROM acts'),
    provisions: count('SELECT COUNT(*) AS n FROM provisions'),
    commit: process.env.GITHUB_SHA ?? null,
  };
  db.close();

  fs.writeFileSync(path.join(out, 'lexbg.db.gz'), gz);
  fs.writeFileSync(path.join(out, 'lexbg-manifest.json'), JSON.stringify(manifest, null, 2));
  const coverageMd = path.join(path.dirname(dbFile), 'coverage.md');
  if (fs.existsSync(coverageMd)) fs.copyFileSync(coverageMd, path.join(out, 'coverage.md'));

  const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;
  fs.writeFileSync(path.join(out, 'notes.md'), [
    '# LexBG database',
    '',
    `Built **${manifest.built_at}** from parliament.bg and EUR-Lex. Latest act in the catalogue: ${manifest.latest_act_date ?? '–'}.`,
    '',
    `- ${manifest.acts} promulgated acts, ${manifest.provisions} provisions`,
    `- Bulgarian laws: ${manifest.laws.tracked} tracked — ${manifest.laws.consolidated} consolidated, ${manifest.laws.original} original text, ${manifest.laws.missing} amendment history only`,
    `- EU acts with text: ${manifest.eu_acts_with_text}`,
    `- Download: ${mb(manifest.gz_bytes)} compressed, ${mb(manifest.bytes)} on disk`,
    '',
    'LexBG downloads this automatically on first start. Rebuilt every week by `.github/workflows/data.yml`.',
    '',
    'Sources: National Assembly of the Republic of Bulgaria (parliament.bg) — normative acts are not subject to copyright (чл. 4, т. 1 ЗАПСП); EUR-Lex / Publications Office — © European Union, https://eur-lex.europa.eu, reused under the EUR-Lex legal notice. Not legal advice.',
    '',
  ].join('\n'));

  console.log(`release/lexbg.db.gz ${mb(gz.length)} (db ${mb(raw.length)}), sha256 ${manifest.sha256.slice(0, 12)}…`);
}

main();
