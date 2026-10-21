/**
 * The prebuilt-database download (first start, checksums, updates) and the MCP prompts,
 * against a local HTTP server that plays the role of GitHub Releases.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lexbg-dist-'));
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

const files = new Map<string, Buffer>();
let server: http.Server;
let hits: string[] = [];

function publish(db: Buffer, builtAt: string, corruptGz = false) {
  const gz = zlib.gzipSync(db);
  files.set('/lexbg.db.gz', corruptGz ? Buffer.concat([gz, Buffer.from('x')]) : gz);
  files.set('/lexbg-manifest.json', Buffer.from(JSON.stringify({
    format: 1, schema_version: '1', built_at: builtAt, sha256: sha(db), gz_sha256: sha(gz), gz_bytes: gz.length,
  })));
}

beforeAll(async () => {
  process.env.LEXBG_RAW = path.join(ROOT, 'fixtures', 'raw');
  process.env.LEXBG_MANUAL = path.join(ROOT, 'fixtures', 'manual-test');
  const { buildDatabase } = await import('../scripts/build-db.js');
  buildDatabase(path.join(tmp, 'published.db'));
  server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    const body = files.get(req.url ?? '');
    if (!body) { res.writeHead(404).end(); return; }
    res.writeHead(200).end(body);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  process.env.LEXBG_DATA_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  delete process.env.LEXBG_DB;
});

afterAll(() => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  hits = [];
});

describe('prebuilt database download', () => {
  it('downloads, verifies and installs the database on first start', async () => {
    const home = path.join(tmp, 'home1');
    process.env.LEXBG_HOME = home;
    publish(fs.readFileSync(path.join(tmp, 'published.db')), '2026-10-20T00:00:00Z');
    const { resolveDatabase } = await import('../src/data.js');
    const r = await resolveDatabase({ useRepoDb: false });
    expect(r.source).toBe('downloaded');
    expect(r.file).toBe(path.join(home, 'lexbg.db'));
    expect(fs.readFileSync(r.file).equals(fs.readFileSync(path.join(tmp, 'published.db')))).toBe(true);

    // second start: uses the cache, and the update check is skipped (checked < 24 h ago)
    const again = await resolveDatabase({ useRepoDb: false });
    expect(again.source).toBe('cache');
    expect(await again.update).toBe('checked recently');
  });

  it('refuses a corrupted download', async () => {
    process.env.LEXBG_HOME = path.join(tmp, 'home2');
    publish(fs.readFileSync(path.join(tmp, 'published.db')), '2026-10-20T00:00:00Z', true);
    const { resolveDatabase } = await import('../src/data.js');
    await expect(resolveDatabase({ useRepoDb: false })).rejects.toThrow(/checksum mismatch/);
    expect(fs.existsSync(path.join(tmp, 'home2', 'lexbg.db'))).toBe(false);
  });

  it('installs a newer weekly database in the background', async () => {
    const home = path.join(tmp, 'home3');
    process.env.LEXBG_HOME = home;
    const original = fs.readFileSync(path.join(tmp, 'published.db'));
    publish(original, '2026-10-20T00:00:00Z');
    const { resolveDatabase } = await import('../src/data.js');
    await resolveDatabase({ useRepoDb: false });

    // a week later: new data is published and the last check is old
    const state = JSON.parse(fs.readFileSync(path.join(home, 'lexbg-manifest.json'), 'utf8'));
    fs.writeFileSync(path.join(home, 'lexbg-manifest.json'), JSON.stringify({ ...state, checked_at: '2026-01-01T00:00:00Z' }));
    // publish a "next week" build: same data with a new built_at, hence a new checksum
    const { DatabaseSync } = await import('node:sqlite');
    const copy = path.join(tmp, 'newer.db');
    fs.writeFileSync(copy, original);
    const d = new DatabaseSync(copy);
    d.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('built_at', '2026-10-27T00:00:00Z')");
    d.close();
    publish(fs.readFileSync(copy), '2026-10-27T00:00:00Z');

    const r = await resolveDatabase({ useRepoDb: false });
    expect(r.source).toBe('cache');
    expect(await r.update).toBe('updated to 2026-10-27T00:00:00Z');
    expect(fs.readFileSync(r.file).equals(fs.readFileSync(copy))).toBe(true);
  });

  it('works offline with a cached database and never calls the network', async () => {
    process.env.LEXBG_HOME = path.join(tmp, 'home1');
    process.env.LEXBG_OFFLINE = '1';
    const { resolveDatabase } = await import('../src/data.js');
    const r = await resolveDatabase({ useRepoDb: false });
    expect(r.source).toBe('cache');
    expect(await r.update).toBe('offline');
    expect(hits).toEqual([]);
    delete process.env.LEXBG_OFFLINE;
  });
});

describe('server with a database that is still downloading', () => {
  it('answers the handshake at once and tool calls wait for the database', async () => {
    const { openDb } = await import('../src/db.js');
    const { loadRegistry } = await import('../src/registry.js');
    const { createServer } = await import('../src/server.js');
    let release!: () => void;
    const db = new Promise<ReturnType<typeof openDb>>(r => {
      release = () => r(openDb(path.join(tmp, 'published.db'), { readOnly: true }));
    });
    const srv = createServer(db, loadRegistry());
    const [a, b] = InMemoryTransport.createLinkedPair();
    await srv.connect(a);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(b);

    expect((await client.listTools()).tools).toHaveLength(10);
    const pending = client.callTool({ name: 'about', arguments: {} });
    setTimeout(release, 50);
    const res = await pending;
    expect(JSON.parse((res.content as Array<{ text: string }>)[0].text).name).toBe('LexBG');

    const { prompts } = await client.listPrompts();
    expect(prompts.map(p => p.name).sort()).toEqual(['check_citations', 'compliance_review', 'legal_research', 'whats_new']);
    const p = await client.getPrompt({ name: 'legal_research', arguments: { question: 'Колко години се пазят ведомостите?' } });
    const text = (p.messages[0].content as { text: string }).text;
    expect(text).toContain('get_provision');
    expect(text).toContain('Колко години се пазят ведомостите?');
    await client.close();
  });

  it('uses the law registry stored inside the database, so old installs understand new builds', async () => {
    const { openDb } = await import('../src/db.js');
    const { createServer, registryFor } = await import('../src/server.js');
    const db = openDb(path.join(tmp, 'published.db'), { readOnly: true });
    expect(registryFor(db).root).toBe('(database)');
    expect(registryFor(db).laws.length).toBeGreaterThan(30);
    const srv = createServer(db); // no registry passed: taken from the database
    const [a, b] = InMemoryTransport.createLinkedPair();
    await srv.connect(a);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(b);
    const res = await client.callTool({ name: 'get_provision', arguments: { law: 'Закон за счетоводството', provision: 'чл. 12' } });
    expect(JSON.parse((res.content as Array<{ text: string }>)[0].text).found).toBe(true);
    await client.close();
    db.close();
  });

  it('reports a clear error when the database cannot be obtained', async () => {
    const { loadRegistry } = await import('../src/registry.js');
    const { createServer } = await import('../src/server.js');
    const srv = createServer(Promise.reject(new Error('offline and no cache')), loadRegistry());
    const [a, b] = InMemoryTransport.createLinkedPair();
    await srv.connect(a);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(b);
    const res = await client.callTool({ name: 'about', arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toContain('offline and no cache');
    await client.close();
  });
});
