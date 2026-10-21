#!/usr/bin/env tsx
/**
 * Build data/lexbg.db from the raw downloads (data/raw) and manual consolidated texts (data/manual).
 *
 *   npm run build:db
 *   npm run build:db -- --out /tmp/test.db     (custom output path)
 *   LEXBG_RAW=fixtures/raw npm run build:db    (build from the test fixtures)
 */
import '../src/quiet.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { createSchema, defaultDbPath, openDb, type Db } from '../src/db.js';
import { loadRegistry, type LawEntry } from '../src/registry.js';
import { htmlToLines, textToLines } from '../src/text/html.js';
import { parseBulgarianAct, type ParsedProvision } from '../src/text/parse-bg.js';
import { extractEuTitle, parseEuAct } from '../src/text/parse-eu.js';
import { extractEuReferences } from '../src/text/eu-refs.js';
import {
  baseTitleMatch, directTarget, indirectTarget, isAmendingTitle, repealTarget,
} from '../src/amendments.js';
import { writeCoverageReport } from '../src/coverage.js';
import { argValue, paths } from './lib/paths.js';

interface RawAct {
  L_Act_id: number;
  L_ActL_final?: string;
  L_ActL_final_body: string;
  L_Act_date?: string;   // date the bill was submitted
  L_Act_date2?: string;  // date the National Assembly adopted the act
  L_Act_dv_iss?: string | number;
  L_Act_dv_year?: string | number;
  L_Act_sign?: string;
}

interface CatalogEntry { t_id: number; t_date: string; t_label: string }

interface ActRecord {
  id: number;
  title: string;
  date: string | null;
  gazette: string | null;
  url: string;
  sign: string | null;
  sections: ParsedProvision[];
}

interface ManualMeta {
  source_url: string;
  current_as_of?: string;
  retrieved_at?: string;
  note?: string;
}

const toDate = (v: unknown): string | null => {
  if (typeof v !== 'string' || !v) return null;
  const m = v.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const bg = v.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  return bg ? `${bg[3]}-${bg[2].padStart(2, '0')}-${bg[1].padStart(2, '0')}` : null;
};

function loadActs(): ActRecord[] {
  const catalog = new Map<number, CatalogEntry>();
  if (fs.existsSync(paths.catalog)) {
    for (const e of JSON.parse(fs.readFileSync(paths.catalog, 'utf8')) as CatalogEntry[]) catalog.set(e.t_id, e);
  }
  if (!fs.existsSync(paths.parliamentActs)) return [];
  const acts: ActRecord[] = [];
  for (const file of fs.readdirSync(paths.parliamentActs).filter(f => f.endsWith('.json'))) {
    const raw = JSON.parse(fs.readFileSync(path.join(paths.parliamentActs, file), 'utf8')) as RawAct;
    const id = Number(raw.L_Act_id ?? file.replace('.json', ''));
    const cat = catalog.get(id);
    const title = (raw.L_ActL_final || cat?.t_label || `Акт ${id}`).replace(/\s+/g, ' ').trim();
    acts.push({
      id,
      title,
      date: toDate(raw.L_Act_date2) ?? toDate(cat?.t_date) ?? toDate(raw.L_Act_date),
      gazette: raw.L_Act_dv_iss && raw.L_Act_dv_year && String(raw.L_Act_dv_iss) !== '0'
        ? `ДВ, бр. ${raw.L_Act_dv_iss} от ${raw.L_Act_dv_year} г.` : null,
      url: `https://www.parliament.bg/bg/laws/ID/${id}`,
      sign: raw.L_Act_sign ?? null,
      sections: parseBulgarianAct(htmlToLines(raw.L_ActL_final_body ?? '')),
    });
  }
  return acts.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.id - b.id);
}

function loadManual(lawId: string): { provisions: ParsedProvision[]; meta: ManualMeta; file: string } | null {
  for (const ext of ['.html', '.htm', '.txt']) {
    const file = path.join(paths.manual, `${lawId}${ext}`);
    if (!fs.existsSync(file)) continue;
    const metaFile = path.join(paths.manual, `${lawId}.yml`);
    if (!fs.existsSync(metaFile)) {
      throw new Error(`${file} has no ${lawId}.yml next to it. Add one with at least "source_url:" (see DATA_SOURCES.md).`);
    }
    const meta = YAML.parse(fs.readFileSync(metaFile, 'utf8')) as ManualMeta;
    if (!meta?.source_url) throw new Error(`${metaFile}: "source_url" is required.`);
    const content = fs.readFileSync(file, 'utf8');
    const lines = ext === '.txt' ? textToLines(content) : htmlToLines(content);
    return { provisions: parseBulgarianAct(lines), meta, file };
  }
  return null;
}

function insertProvisions(db: Db, lawId: string, provisions: ParsedProvision[]): number {
  const ins = db.prepare(`INSERT INTO provisions (law_id, ord, kind, num, part, part_key, part_title, chapter, label, text)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const fts = db.prepare('INSERT INTO provisions_fts (rowid, text, label, chapter) VALUES (?, ?, ?, ?)');
  const ref = db.prepare('INSERT INTO eu_refs (provision_id, law_id, celex, citation) VALUES (?, ?, ?, ?)');
  for (const p of provisions) {
    const r = ins.run(lawId, p.ord, p.kind, p.num, p.part, p.partKey, p.partTitle ?? null, p.chapter ?? null, p.label, p.text);
    const id = Number(r.lastInsertRowid);
    fts.run(id, p.text, p.label, p.chapter ?? '');
    for (const e of extractEuReferences(p.text)) ref.run(id, lawId, e.celex, e.text);
  }
  return provisions.length;
}

export function buildDatabase(outPath?: string): { out: string; summary: string; acts: number } {
  const reg = loadRegistry();
  const out = path.resolve(outPath ?? defaultDbPath());
  const tmp = `${out}.building`;
  for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) if (fs.existsSync(f)) fs.rmSync(f);

  const db = openDb(tmp);
  createSchema(db);
  // Rows are inserted acts-first; integrity is verified with foreign_key_check before commit.
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');

  // 1. Promulgated acts + amendment links ------------------------------------------------------
  const acts = loadActs();
  const insAct = db.prepare('INSERT INTO acts (act_id, title, adopted, state_gazette, url, sign, is_amending, has_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insSec = db.prepare('INSERT INTO act_sections (act_id, ord, label, part, text) VALUES (?, ?, ?, ?, ?)');
  const insAmend = db.prepare('INSERT OR IGNORE INTO amendments (act_id, law_id, mode, section_ords) VALUES (?, ?, ?, ?)');

  const baseActs = new Map<string, ActRecord>();
  for (const act of acts) {
    insAct.run(act.id, act.title, act.date, act.gazette, act.url, act.sign, isAmendingTitle(act.title) ? 1 : 0, act.sections.length ? 1 : 0);
    for (const s of act.sections) insSec.run(act.id, s.ord, s.label, s.partKey, s.text);

    const base = baseTitleMatch(act.title, reg.laws);
    if (base) {
      const prev = baseActs.get(base.id);
      if (!prev || (act.date ?? '') >= (prev.date ?? '')) baseActs.set(base.id, act);
    }

    const direct = directTarget(act.title, reg.laws);
    if (direct) insAmend.run(act.id, direct.id, 'direct', '[]');
    const repeal = repealTarget(act.title, reg.laws);
    if (repeal) insAmend.run(act.id, repeal.id, 'repeal', '[]');

    const indirect = new Map<string, number[]>();
    for (const s of act.sections) {
      const target = indirectTarget(s.text, reg.laws);
      if (target && target.id !== direct?.id && target.id !== base?.id) {
        indirect.set(target.id, [...(indirect.get(target.id) ?? []), s.ord]);
      }
    }
    for (const [lawId, ords] of indirect) insAmend.run(act.id, lawId, 'indirect', JSON.stringify(ords));
  }

  // 2. Bulgarian laws ---------------------------------------------------------------------------
  const insLaw = db.prepare(`INSERT INTO laws (id, kind, short, title, topics, text_status, source_kind, source_url, source_note,
                              retrieved_at, base_act_id, adopted, state_gazette, celex, status)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const amendStats = db.prepare(`SELECT COUNT(*) AS n, MAX(a.adopted) AS last,
                                        SUM(CASE WHEN a.adopted > ? THEN 1 ELSE 0 END) AS after
                                   FROM amendments m JOIN acts a ON a.act_id = m.act_id
                                  WHERE m.law_id = ? AND m.mode != 'repeal'
                                    AND (? IS NULL OR a.adopted > ?)`);
  const repealed = db.prepare(`SELECT 1 FROM amendments m JOIN acts a ON a.act_id = m.act_id
                               WHERE m.law_id = ? AND m.mode = 'repeal' AND (? IS NULL OR a.adopted > ?)`);
  const updLaw = db.prepare(`UPDATE laws SET amendments_total = ?, amendments_after_text = ?, last_amended = ?,
                             provision_count = ?, status = ? WHERE id = ?`);

  for (const law of reg.laws) {
    const manual = loadManual(law.id);
    const base = baseActs.get(law.id);
    let provisions: ParsedProvision[] = [];
    let textDate: string | null = null;

    if (manual) {
      provisions = manual.provisions;
      textDate = toDate(manual.meta.current_as_of) ?? toDate(manual.meta.retrieved_at);
      insLaw.run(law.id, 'bg', law.short, law.title, JSON.stringify(law.topics), 'consolidated', 'manual',
        manual.meta.source_url, manual.meta.note ?? null, textDate, base?.id ?? null, base?.date ?? null, base?.gazette ?? null, null, 'in_force');
    } else if (base) {
      provisions = base.sections;
      textDate = base.date;
      insLaw.run(law.id, 'bg', law.short, law.title, JSON.stringify(law.topics), 'original', 'parliament.bg',
        base.url, `Original act as adopted (parliament.bg act ${base.id}).`, null, base.id, base.date, base.gazette, null, 'in_force');
    } else {
      insLaw.run(law.id, 'bg', law.short, law.title, JSON.stringify(law.topics), 'missing', null,
        null, null, null, null, null, null, null, 'in_force');
    }

    const count = insertProvisions(db, law.id, provisions);
    // Only count amendments adopted after the law was (re-)enacted, if we know when that was.
    const since = base?.date ?? null;
    const s = amendStats.get(textDate ?? '0000-00-00', law.id, since, since) as { n: number; last: string | null; after: number | null };
    const isRepealed = Boolean(repealed.get(law.id, since, since));
    updLaw.run(s.n, s.after ?? 0, s.last, count, isRepealed ? 'repealed' : 'in_force', law.id);
  }

  // 3. EU acts ----------------------------------------------------------------------------------
  for (const eu of reg.eu) {
    const file = path.join(paths.eurlex, `${eu.celex}.html`);
    let provisions: ParsedProvision[] = [];
    let title = eu.title;
    if (fs.existsSync(file)) {
      const lines = htmlToLines(fs.readFileSync(file, 'utf8'));
      provisions = parseEuAct(lines);
      title = extractEuTitle(lines) ?? eu.title;
    }
    insLaw.run(eu.celex, 'eu', eu.short, title, JSON.stringify(eu.topics), provisions.length ? 'original' : 'missing',
      provisions.length ? 'eur-lex' : null,
      `https://eur-lex.europa.eu/legal-content/BG/TXT/?uri=CELEX:${eu.celex}`,
      provisions.length ? 'Text as published in the Official Journal. EUR-Lex also offers consolidated versions.' : null,
      null, null, null, null, eu.celex, 'in_force');
    updLaw.run(0, 0, null, insertProvisions(db, eu.celex, provisions), 'in_force', eu.celex);
  }

  // 4. Optional extracted obligations -----------------------------------------------------------
  const oblDir = path.join(paths.manual, '..', 'obligations');
  let obligations = 0;
  if (fs.existsSync(oblDir)) {
    const findProv = db.prepare('SELECT id FROM provisions WHERE law_id = ? AND label = ? ORDER BY ord LIMIT 1');
    const ins = db.prepare(`INSERT INTO obligations (law_id, provision_id, subject, action, deadline, quote, review_status, model, extracted_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const f of fs.readdirSync(oblDir).filter(x => x.endsWith('.json'))) {
      const doc = JSON.parse(fs.readFileSync(path.join(oblDir, f), 'utf8')) as {
        law_id: string; model?: string; extracted_at?: string;
        items: Array<{ provision: string; subject: string; action: string; deadline?: string; quote: string; review_status?: string }>;
      };
      for (const it of doc.items) {
        const p = findProv.get(doc.law_id, it.provision) as { id: number } | undefined;
        if (!p) continue;
        ins.run(doc.law_id, p.id, it.subject, it.action, it.deadline ?? null, it.quote,
          it.review_status ?? 'unreviewed', doc.model ?? null, doc.extracted_at ?? null);
        obligations += 1;
      }
    }
  }

  // 5. Metadata ---------------------------------------------------------------------------------
  const meta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  meta.run('built_at', new Date().toISOString());
  meta.run('latest_act_date', acts.length ? (acts[acts.length - 1].date ?? '') : '');
  meta.run('acts', String(acts.length));
  // Keep the text of acts only where it matters (acts that amend/repeal a tracked law) — the rest
  // of parliament's output (ratifications, budgets' unrelated §, ...) would only bloat the file.
  db.exec('DELETE FROM act_sections WHERE act_id NOT IN (SELECT act_id FROM amendments)');
  const broken = db.prepare('PRAGMA foreign_key_check').all();
  if (broken.length) throw new Error(`Database integrity check failed: ${JSON.stringify(broken.slice(0, 5))}`);
  db.exec('COMMIT');
  db.exec("INSERT INTO provisions_fts(provisions_fts) VALUES('optimize')");
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec('VACUUM');
  db.close();

  for (const f of [out, `${out}-wal`, `${out}-shm`]) if (fs.existsSync(f)) fs.rmSync(f);
  fs.renameSync(tmp, out);
  for (const suffix of ['-wal', '-shm']) if (fs.existsSync(tmp + suffix)) fs.rmSync(tmp + suffix);

  const check = openDb(out, { readOnly: true });
  const report = writeCoverageReport(check, path.join(path.dirname(out), 'coverage.md'));
  check.close();
  return { out, summary: `${acts.length} acts, ${obligations} obligations. ${report.summary}`, acts: acts.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const result = buildDatabase(argValue('--out'));
  console.log(`Built ${path.relative(process.cwd(), result.out)}: ${result.summary}`);
}
