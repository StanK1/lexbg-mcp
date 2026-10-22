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
import { loadRegistry, registryToJson, type LawEntry } from '../src/registry.js';
import { htmlToLines, textToLines } from '../src/text/html.js';
import { parseBulgarianAct, type ParsedProvision } from '../src/text/parse-bg.js';
import { extractEuTitle, parseEuAct } from '../src/text/parse-eu.js';
import { extractEuReferences } from '../src/text/eu-refs.js';
import {
  baseTitleMatch, directTarget, indirectTarget, isAmendingTitle, repealTarget,
} from '../src/amendments.js';
import { writeCoverageReport } from '../src/coverage.js';
import { compileLaw, issueOf, type AmendingAct, type CompileResult } from '../src/consolidate/apply.js';
import { parseInForce, resolveWhen, whenFor } from '../src/consolidate/in-force.js';
import { makeLabel } from '../src/text/parse-bg.js';
import { compareIssues, headerIssues, latestIssue } from '../src/text/consolidated.js';
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
  institution?: string;
  /** Last State Gazette issue included, e.g. "ДВ, бр. 72 от 2024 г." (read from the text header if absent). */
  through_gazette?: string;
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

/**
 * Compile the current text of a law from its original and the amending acts (LexBG's own
 * consolidation). Returns null when there is nothing to apply.
 */
type Link = { act: ActRecord; mode: 'direct' | 'indirect' | 'repeal'; ords: number[] };

function compileFromActs(law: LawEntry, baseProvisions: ParsedProvision[], relevant: Link[], acts: ActRecord[], coveredUpTo?: string): { result: CompileResult; inForce: Map<number, string> } | null {
  if (!relevant.length) return null;
  const genitives = [law.genitive, ...(law.genitives ?? [])];
  const inForce = new Map<number, string>();
  const amending: AmendingAct[] = relevant.map(({ act, mode, ords }) => {
    const sections = act.sections.filter(s => (mode === 'indirect' ? ords.includes(s.ord) : s.part === 'main'));
    const inf = parseInForce(act.sections.filter(s => /влиза(?:т)?\s+в\s+сила/u.test(s.text)).map(s => s.text));
    const dates = sections.map(s => {
      const r = resolveWhen(whenFor(inf, s.label.match(/§\s*(\d+[а-я]?)/u)?.[1] ?? null), act.date);
      return r.date ? `${r.date}${r.estimated ? ' (estimated)' : ''}` : null;
    }).filter(Boolean) as string[];
    if (dates.length) inForce.set(act.id, [...new Set(dates)].sort().join(', '));
    return { actId: act.id, title: act.title, adopted: act.date, stateGazette: act.gazette, mode, sections: sections.map(s => ({ label: s.label, text: s.text })), inForce: inf };
  });
  const nameRe = new RegExp(genitives.map(g => g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')).join('|'), 'u');
  const mentions = (issue: string) => acts
    .filter(a => issueOf(a.gazette) === issue && a.sections.some(s => nameRe.test(s.text)))
    .map(a => a.title);
  const result = compileLaw(
    baseProvisions.filter(p => p.kind === 'art' || p.kind === 'par').map(p => ({
      kind: p.kind as 'art' | 'par', num: p.num, part: p.part, partKey: p.partKey, partTitle: p.partTitle,
      chapter: p.chapter, glava: p.glava, text: p.text,
    })),
    // LEXBG_COMPILE_AS_OF=2024-08-31 compiles the text as it stood on that date (for checking against references)
    amending, genitives, { mentions, coveredUpTo, today: process.env.LEXBG_COMPILE_AS_OF || undefined },
  );
  return { result, inForce };
}

function insertProvisions(db: Db, lawId: string, provisions: ParsedProvision[]): number {
  const ins = db.prepare(`INSERT INTO provisions (law_id, ord, kind, num, part, part_key, part_title, chapter, label, text)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const fts = db.prepare('INSERT INTO provisions_fts (rowid, text, label, chapter) VALUES (?, ?, ?, ?)');
  const ref = db.prepare('INSERT INTO eu_refs (provision_id, law_id, celex, citation) VALUES (?, ?, ?, ?)');
  const seen = new Set<string>();
  for (const p of provisions) {
    // Sources occasionally repeat a number (misprints, quoted articles); keep both, disambiguated.
    let partKey = p.partKey;
    for (let n = 2; seen.has(`${p.kind}|${p.num}|${partKey}`); n++) partKey = `${p.partKey}~${n}`;
    seen.add(`${p.kind}|${p.num}|${partKey}`);
    const r = ins.run(lawId, p.ord, p.kind, p.num, p.part, partKey, p.partTitle ?? null, p.chapter ?? null, p.label, p.text);
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
  const links = new Map<string, Link[]>();
  const link = (lawId: string, act: ActRecord, mode: 'direct' | 'indirect' | 'repeal', ords: number[]) => {
    if (!links.has(lawId)) links.set(lawId, []);
    if (!links.get(lawId)!.some(l => l.act.id === act.id)) links.get(lawId)!.push({ act, mode, ords });
  };
  for (const act of acts) {
    insAct.run(act.id, act.title, act.date, act.gazette, act.url, act.sign, isAmendingTitle(act.title) ? 1 : 0, act.sections.length ? 1 : 0);
    for (const s of act.sections) insSec.run(act.id, s.ord, s.label, s.partKey, s.text);

    const base = baseTitleMatch(act.title, reg.laws);
    if (base) {
      const prev = baseActs.get(base.id);
      if (!prev || (act.date ?? '') >= (prev.date ?? '')) baseActs.set(base.id, act);
    }

    const direct = directTarget(act.title, reg.laws);
    if (direct) { insAmend.run(act.id, direct.id, 'direct', '[]'); link(direct.id, act, 'direct', []); }
    const repeal = repealTarget(act.title, reg.laws);
    if (repeal) { insAmend.run(act.id, repeal.id, 'repeal', '[]'); link(repeal.id, act, 'repeal', []); }

    const indirect = new Map<string, number[]>();
    for (const s of act.sections) {
      const target = indirectTarget(s.text, reg.laws);
      if (target && target.id !== direct?.id && target.id !== base?.id) {
        indirect.set(target.id, [...(indirect.get(target.id) ?? []), s.ord]);
      }
    }
    for (const [lawId, ords] of indirect) { insAmend.run(act.id, lawId, 'indirect', JSON.stringify(ords)); link(lawId, act, 'indirect', ords); }
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

    /** Try LexBG's compilation on top of a base text; returns the compiled provisions or null. */
    const tryCompile = (baseProvs: ParsedProvision[], relevant: Link[], coveredUpTo?: string): { provisions: ParsedProvision[]; r: CompileResult } | null => {
      let compiled: ReturnType<typeof compileFromActs> = null;
      try {
        compiled = compileFromActs(law, baseProvs, relevant, acts, coveredUpTo);
      } catch (err) {
        warn(`${law.short}: compiling the current text failed: ${(err as Error).message}`);
      }
      if (!compiled) return null;
      const upd = db.prepare('UPDATE amendments SET in_force = ? WHERE act_id = ? AND law_id = ?');
      for (const [actId, date] of compiled.inForce) upd.run(date, actId, law.id);
      const r = compiled.result;
      const tried = r.stats.applied + r.stats.failed;
      // Use the compiled text only when most instructions could be applied and the catalogue is
      // (nearly) complete — amendments missing from the catalogue cannot be applied.
      if (!(r.stats.applied > 0 && r.stats.failed / tried <= 0.25 && r.missingFromCatalogue.length <= 2)) {
        console.log(`  ${law.short}: compiled text NOT used (${r.stats.applied} applied, ${r.stats.failed} failed, ${r.missingFromCatalogue.length} amending act(s) missing from the catalogue)`);
        return null;
      }
      console.log(`  ${law.short}: compiled from ${r.stats.acts} amending acts — ${r.stats.applied} applied, ${r.stats.failed} failed, ${r.stats.skipped} skipped, ${r.stats.pending} pending`
        + `${r.missingFromCatalogue.length ? `; missing from catalogue: ${r.missingFromCatalogue.join(', ')}` : ''}`);
      return {
        r,
        provisions: r.provisions.map((p, i) => ({
          ord: i + 1, kind: p.kind, num: p.num, part: p.part, partKey: p.partKey, partTitle: p.partTitle,
          chapter: p.chapter, glava: p.glava, label: makeLabel(p.kind, p.num, p.part), text: p.text,
        })),
      };
    };
    const storeCompiled = (r: CompileResult) => {
      db.prepare(`UPDATE laws SET compiled_through = ?, compile_applied = ?, compile_failed = ?, compile_pending = ?,
                  compile_missing = ?, compile_mentioned = ? WHERE id = ?`)
        .run(r.through ?? null, r.stats.applied, r.stats.failed, r.stats.pending,
          JSON.stringify(r.missingFromCatalogue), JSON.stringify(r.mentionedOnly), law.id);
      const insChange = db.prepare(`INSERT INTO provision_changes (law_id, kind, num, part, act_id, state_gazette, section, summary,
                                    status, note, instruction, in_force, in_force_estimated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const c of r.changes) {
        const [kind, num, part] = c.key ? c.key.split('|') : [null, null, null];
        insChange.run(law.id, kind, num, part, c.actId, c.gazette, c.section, c.summary, c.status, c.note ?? null,
          c.instruction, c.inForce ?? null, c.inForceEstimated ? 1 : 0);
      }
    };
    const pfx = (r: CompileResult) => `${r.stats.failed ? `; ${r.stats.failed} instruction(s) could not be applied` : ''}${r.stats.pending ? `; ${r.stats.pending} take effect later` : ''}`;

    if (manual) {
      provisions = manual.provisions;
      textDate = toDate(manual.meta.current_as_of) ?? toDate(manual.meta.retrieved_at);
      // A consolidated snapshot: apply the amending acts published after the last issue it includes.
      const through = issueOf(manual.meta.through_gazette ?? null) ?? latestIssue(headerIssues(fs.readFileSync(manual.file, 'utf8')));
      const later = through
        ? (links.get(law.id) ?? []).filter(l => l.mode !== 'repeal' && l.act.gazette && compareIssues(issueOf(l.act.gazette)!, through) > 0)
        : [];
      const c = later.length ? tryCompile(manual.provisions, later, through ?? undefined) : null;
      const who = manual.meta.institution ?? 'an official source';
      if (c) {
        provisions = c.provisions;
        textDate = acts.length ? (acts[acts.length - 1].date ?? null) : textDate;
        insLaw.run(law.id, 'bg', law.short, law.title, JSON.stringify(law.topics), 'compiled', 'manual+lexbg',
          manual.meta.source_url, `Consolidated text from ${who} (through ${manual.meta.through_gazette ?? through}) with ${c.r.stats.acts} later amending act(s) applied by LexBG${pfx(c.r)}.`,
          textDate, base?.id ?? null, base?.date ?? null, base?.gazette ?? null, null, 'in_force');
        storeCompiled(c.r);
      } else {
        insLaw.run(law.id, 'bg', law.short, law.title, JSON.stringify(law.topics), 'consolidated', 'manual',
          manual.meta.source_url, manual.meta.note ?? `Consolidated text from ${who}.`, textDate, base?.id ?? null, base?.date ?? null, base?.gazette ?? null, null, 'in_force');
      }
    } else if (base) {
      provisions = base.sections;
      textDate = base.date;
      const c = tryCompile(base.sections, (links.get(law.id) ?? []).filter(l => l.mode !== 'repeal' && (l.act.date ?? '') > (base.date ?? '')));
      if (c) {
        provisions = c.provisions;
        textDate = acts.length ? (acts[acts.length - 1].date ?? null) : null;
        insLaw.run(law.id, 'bg', law.short, law.title, JSON.stringify(law.topics), 'compiled', 'lexbg-compiled',
          base.url, `Original act (${base.gazette ?? `parliament.bg act ${base.id}`}) with ${c.r.stats.acts} amending act(s) applied by LexBG through ${c.r.through ?? '–'}${pfx(c.r)}.`,
          textDate, base.id, base.date, base.gazette, null, 'in_force');
        storeCompiled(c.r);
      } else {
        insLaw.run(law.id, 'bg', law.short, law.title, JSON.stringify(law.topics), 'original', 'parliament.bg',
          base.url, `Original act as adopted (parliament.bg act ${base.id}).`, null, base.id, base.date, base.gazette, null, 'in_force');
      }
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
      try {
        const lines = htmlToLines(fs.readFileSync(file, 'utf8'));
        provisions = parseEuAct(lines);
        title = extractEuTitle(lines) ?? eu.title;
      } catch (err) {
        warn(`${eu.short} (${eu.celex}): could not parse ${file}: ${(err as Error).message}`);
        provisions = [];
      }
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
  // The registry travels with the database, so an older LexBG install can serve a newer weekly build.
  meta.run('registry', registryToJson(reg));

  // Keep act text only where the tools use it: every section of acts that amend or repeal a tracked
  // law directly, and only the listed § of acts that amend one indirectly (a budget law that amends
  // the VAT Act in one § does not need its other 300 §). Titles, dates and ДВ stay for every act.
  db.exec(`DELETE FROM act_sections
            WHERE act_id NOT IN (SELECT act_id FROM amendments WHERE mode IN ('direct', 'repeal'))
              AND NOT EXISTS (SELECT 1 FROM amendments m, json_each(m.section_ords) j
                               WHERE m.act_id = act_sections.act_id AND m.mode = 'indirect' AND j.value = act_sections.ord)`);
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

function warn(msg: string): void {
  console.warn(process.env.GITHUB_ACTIONS ? `::warning title=build-db::${msg}` : `warning: ${msg}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const result = buildDatabase(argValue('--out'));
    console.log(`Built ${path.relative(process.cwd(), result.out)}: ${result.summary}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // On GitHub Actions, surface the reason as an annotation (visible without opening the log).
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=build-db failed::${msg.replace(/\n/g, ' ')}`);
    console.error(err);
    process.exit(1);
  }
}
