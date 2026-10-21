import './quiet.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { findRoot } from './registry.js';

export type Db = DatabaseSync;

// Load node:sqlite lazily, after ./quiet.js has installed its warning filter
// (a static import would be evaluated before any of our code runs).
const require = createRequire(import.meta.url);
function sqlite(): typeof import('node:sqlite') {
  return require('node:sqlite') as typeof import('node:sqlite');
}

export const SCHEMA_VERSION = '1';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- One row per tracked Bulgarian law (kind = 'bg') or EU act (kind = 'eu').
CREATE TABLE IF NOT EXISTS laws (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('bg', 'eu')),
  short TEXT NOT NULL,
  title TEXT NOT NULL,
  topics TEXT NOT NULL DEFAULT '[]',
  -- consolidated: current text imported from an official consolidated publication
  -- original:     the act as originally promulgated (later amendments NOT applied)
  -- missing:      no text yet; amendments are still tracked
  text_status TEXT NOT NULL CHECK (text_status IN ('consolidated', 'original', 'missing')),
  source_kind TEXT,
  source_url TEXT,
  source_note TEXT,
  retrieved_at TEXT,
  base_act_id INTEGER,
  -- date the National Assembly adopted the act, and its State Gazette publication
  adopted TEXT,
  state_gazette TEXT,
  celex TEXT,
  status TEXT NOT NULL DEFAULT 'in_force',
  amendments_total INTEGER NOT NULL DEFAULT 0,
  amendments_after_text INTEGER NOT NULL DEFAULT 0,
  last_amended TEXT,
  provision_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS provisions (
  id INTEGER PRIMARY KEY,
  law_id TEXT NOT NULL REFERENCES laws(id),
  ord INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('art', 'par', 'body')),
  num TEXT NOT NULL,
  part TEXT NOT NULL,
  part_key TEXT NOT NULL,
  part_title TEXT,
  chapter TEXT,
  label TEXT NOT NULL,
  text TEXT NOT NULL,
  UNIQUE (law_id, kind, num, part_key)
);
CREATE INDEX IF NOT EXISTS idx_provisions_law ON provisions(law_id, ord);

CREATE VIRTUAL TABLE IF NOT EXISTS provisions_fts USING fts5(
  text, label, chapter,
  content = 'provisions', content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Every act promulgated by the National Assembly (catalogue from parliament.bg).
CREATE TABLE IF NOT EXISTS acts (
  act_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  adopted TEXT,
  state_gazette TEXT,
  url TEXT,
  sign TEXT,
  is_amending INTEGER NOT NULL DEFAULT 0,
  has_text INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_acts_date ON acts(adopted);

CREATE TABLE IF NOT EXISTS act_sections (
  id INTEGER PRIMARY KEY,
  act_id INTEGER NOT NULL REFERENCES acts(act_id),
  ord INTEGER NOT NULL,
  label TEXT NOT NULL,
  part TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_act_sections ON act_sections(act_id, ord);

-- Which act changes which tracked law.
--   direct:   the act's title says it amends the law ("Закон за изменение ... на Закона за ...")
--   indirect: a § in another act amends it ("§ 12. В Закона за ... (обн., ДВ ...) се правят ...")
--   repeal:   "Закон за отменяне на ..."
CREATE TABLE IF NOT EXISTS amendments (
  act_id INTEGER NOT NULL REFERENCES acts(act_id),
  law_id TEXT NOT NULL REFERENCES laws(id),
  mode TEXT NOT NULL CHECK (mode IN ('direct', 'indirect', 'repeal')),
  section_ords TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (act_id, law_id)
);
CREATE INDEX IF NOT EXISTS idx_amendments_law ON amendments(law_id);

CREATE TABLE IF NOT EXISTS eu_refs (
  provision_id INTEGER NOT NULL REFERENCES provisions(id),
  law_id TEXT NOT NULL,
  celex TEXT NOT NULL,
  citation TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eu_refs_celex ON eu_refs(celex);
CREATE INDEX IF NOT EXISTS idx_eu_refs_law ON eu_refs(law_id);

-- Optional: obligations extracted by an LLM, every quote verified verbatim against the provision.
CREATE TABLE IF NOT EXISTS obligations (
  id INTEGER PRIMARY KEY,
  law_id TEXT NOT NULL,
  provision_id INTEGER NOT NULL REFERENCES provisions(id),
  subject TEXT NOT NULL,
  action TEXT NOT NULL,
  deadline TEXT,
  quote TEXT NOT NULL,
  review_status TEXT NOT NULL CHECK (review_status IN ('unreviewed', 'approved', 'rejected')),
  model TEXT,
  extracted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_obligations_law ON obligations(law_id);
`;

export function defaultDbPath(): string {
  if (process.env.LEXBG_DB) return path.resolve(process.env.LEXBG_DB);
  return path.join(findRoot(), 'data', 'lexbg.db');
}

export function openDb(file = defaultDbPath(), opts: { readOnly?: boolean } = {}): Db {
  if (opts.readOnly && !fs.existsSync(file)) {
    throw new Error(
      `LexBG database not found at ${file}. Run "npm run build:db" first (see README → Quick start).`,
    );
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new (sqlite().DatabaseSync)(file, { readOnly: opts.readOnly ?? false });
  if (!opts.readOnly) {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  }
  return db;
}

export function createSchema(db: Db): void {
  db.exec(SCHEMA);
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);
}

export function getMeta(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}
