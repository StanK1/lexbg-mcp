/**
 * LexBG query layer. Pure functions over the SQLite database and the YAML registry,
 * shared by the MCP tools, the eval runner and the tests.
 */
import type { Db } from './db.js';
import { getMeta } from './db.js';
import {
  resolveEu, resolveLaw, resolveTopic, type Condition, type Registry, type TopicEntry,
} from './registry.js';
import { allOf, anyOf, buildTermGroups, combinations, coverage, stem, tokenize, type TermGroup } from './text/fts.js';
import { mentionsProvision, withoutOwnNumber } from './text/mentions.js';
import { formatCitation, parseCitation } from './text/citation.js';
import { extractParagraph, extractPoint, type PartCode, type ProvisionKind } from './text/parse-bg.js';
import { getCoverage, textWarning, type LawCoverage } from './coverage.js';

export const DISCLAIMER =
  'LexBG returns verbatim text from official sources for research. It is not legal advice; verify against the State Gazette (Държавен вестник) and consult a qualified professional.';

interface LawRow extends LawCoverage {
  topics: string;
  source_url: string | null;
  source_note: string | null;
  celex: string | null;
  base_act_id: number | null;
}

interface ProvisionRow {
  id: number;
  law_id: string;
  ord: number;
  kind: ProvisionKind;
  num: string;
  part: PartCode;
  part_key: string;
  part_title: string | null;
  chapter: string | null;
  label: string;
  text: string;
}

export class LexBG {
  private readonly lawCache = new Map<string, LawRow>();

  constructor(private readonly db: Db, private readonly reg: Registry) {
    for (const row of db.prepare('SELECT * FROM laws').all() as unknown as LawRow[]) this.lawCache.set(row.id, row);
  }

  // ------------------------------------------------------------------ helpers

  private lawRow(id: string): LawRow | undefined {
    return this.lawCache.get(id);
  }

  /** Resolve free text ("ЗДДС", "GDPR", "32016R0679", "Кодекс на труда") to a law id in the DB. */
  resolveLawId(input: string): string | null {
    const bg = resolveLaw(this.reg, input);
    if (bg) return bg.id;
    const eu = resolveEu(this.reg, input);
    if (eu) return eu.celex;
    const upper = input.trim().toUpperCase();
    if (this.lawCache.has(upper)) return upper;
    return null;
  }

  private lawSummary(row: LawRow) {
    return {
      id: row.id,
      kind: row.kind,
      short: row.short,
      title: row.title,
      text_status: row.text_status,
      status: row.status,
      adopted: row.kind === 'bg' ? row.adopted ?? undefined : undefined,
      state_gazette: row.state_gazette ?? undefined,
      source_url: row.source_url,
      warning: textWarning(row),
    };
  }

  private citationFor(p: Pick<ProvisionRow, 'kind' | 'num' | 'part'>, lawShort: string, extra: { alineya?: string; point?: string } = {}): string {
    return formatCitation({ kind: p.kind, num: p.num, part: p.part, ...extra }, lawShort);
  }

  private unknownLaw(input: string) {
    const known = this.reg.laws.map(l => `${l.short} (${l.id})`).join(', ');
    return { error: `Unknown law "${input}". Known Bulgarian laws: ${known}. EU acts: ${this.reg.eu.map(e => e.short).join(', ')}.` };
  }

  // ------------------------------------------------------------------ about / list

  about() {
    const coverage = getCoverage(this.db);
    const bg = coverage.filter(c => c.kind === 'bg');
    const eu = coverage.filter(c => c.kind === 'eu');
    const n = (s: string) => bg.filter(c => c.text_status === s).length;
    const count = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      name: 'LexBG',
      description: 'Bulgarian legal & compliance research server: laws, amendment history, EU links and compliance topic packs.',
      built_at: getMeta(this.db, 'built_at') ?? null,
      latest_act_in_catalogue: getMeta(this.db, 'latest_act_date') || null,
      bulgarian_laws: { tracked: bg.length, consolidated: n('consolidated'), original_only: n('original'), missing: n('missing') },
      eu_acts: { tracked: eu.length, with_text: eu.filter(c => c.text_status !== 'missing').length },
      provisions: count('SELECT COUNT(*) AS n FROM provisions'),
      promulgated_acts: count('SELECT COUNT(*) AS n FROM acts'),
      amendment_links: count('SELECT COUNT(*) AS n FROM amendments'),
      topics: this.reg.topics.map(t => ({ id: t.id, title: t.title, title_en: t.title_en })),
      sources: ['parliament.bg (promulgated acts)', 'EUR-Lex (EU acts)', 'official consolidated texts imported locally (data/manual)'],
      disclaimer: DISCLAIMER,
    };
  }

  listLaws(opts: { topic?: string; kind?: 'bg' | 'eu' } = {}) {
    let rows = [...this.lawCache.values()];
    if (opts.kind) rows = rows.filter(r => r.kind === opts.kind);
    if (opts.topic) {
      const t = resolveTopic(this.reg, opts.topic);
      if (!t) return { error: `Unknown topic "${opts.topic}". Topics: ${this.reg.topics.map(x => x.id).join(', ')}` };
      rows = rows.filter(r => (JSON.parse(r.topics) as string[]).includes(t.id));
    }
    return {
      laws: rows
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.short.localeCompare(b.short, 'bg'))
        .map(r => ({
          ...this.lawSummary(r),
          topics: JSON.parse(r.topics) as string[],
          provisions: r.provision_count,
          amendments_total: r.kind === 'bg' ? r.amendments_total : undefined,
          last_amended: r.last_amended,
        })),
    };
  }

  // ------------------------------------------------------------------ search

  /** Laws named in a question: abbreviations (ЗДДС, GDPR), titles, or common names (ДДС, лични данни). */
  mentionedLaws(query: string): string[] {
    const q = ` ${query.toLowerCase().replace(/[„“"«»(),.?!:;]/g, ' ').replace(/\s+/g, ' ')} `;
    const found: string[] = [];
    const has = (name: string) => {
      const n = name.toLowerCase().trim();
      return n.length >= 3 && new RegExp(`(?<![\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u').test(q);
    };
    for (const l of this.reg.laws) {
      if ([l.short, l.title, l.genitive, ...(l.base_titles ?? []), ...(l.genitives ?? []), ...(l.aliases ?? [])].some(has)) found.push(l.id);
    }
    for (const e of this.reg.eu) {
      if ([e.short, ...(e.aliases ?? [])].some(has)) found.push(e.celex);
    }
    return found;
  }

  /**
   * Tracked laws that a question is probably about but that have no text in the database:
   * laws the question names, plus the laws of the best-matching topic — the latter only when the
   * top result is not already a full match from a Bulgarian law of that topic.
   */
  private missingRelevantLaws(query: string, groups: TermGroup[], mentioned: string[], top?: { lawId: string; cov: number }): string[] {
    const missing = new Set(mentioned.filter(id => this.lawRow(id)?.text_status === 'missing'));
    if (groups.length >= 2) {
      let best = 0;
      const scored = this.reg.topics.map(t => {
        const words = new Set(tokenize([t.title, t.summary, ...t.queries, ...t.questions].join(' ')).map(stem));
        const hits = groups.filter(g => g.variants.some(v => [...words].some(w => w.startsWith(v.term) || (v.prefix && v.term.startsWith(w) && w.length >= 5)))).length;
        best = Math.max(best, hits);
        return { t, hits };
      });
      if (best >= 2) {
        for (const { t, hits } of scored) {
          if (hits !== best) continue;
          if (top && top.cov === 1 && t.laws.includes(top.lawId)) continue;
          for (const id of t.laws) if (this.lawRow(id)?.text_status === 'missing') missing.add(id);
        }
      }
    }
    return [...missing];
  }

  search(opts: { query: string; law?: string; topic?: string; limit?: number; include_eu?: boolean }) {
    const limit = Math.min(Math.max(opts.limit ?? 8, 1), 30);
    const groups = buildTermGroups(opts.query);
    if (!groups.length) return { error: 'Query has no searchable words. Use Bulgarian legal terms, e.g. "годишен финансов отчет".' };

    let lawIds: string[] | null = null;
    if (opts.law) {
      const id = this.resolveLawId(opts.law);
      if (!id) return this.unknownLaw(opts.law);
      lawIds = [id];
    } else if (opts.topic) {
      const t = resolveTopic(this.reg, opts.topic);
      if (!t) return { error: `Unknown topic "${opts.topic}". Topics: ${this.reg.topics.map(x => x.id).join(', ')}` };
      lawIds = [...t.laws, ...(opts.include_eu === false ? [] : t.eu)];
    } else if (opts.include_eu === false) {
      lawIds = this.reg.laws.map(l => l.id);
    }

    const mentioned = this.mentionedLaws(opts.query);
    // A law named in the question ("по ЗМИП") is a filter/boost, not a word to find in the text.
    const lawWords = new Set(mentioned.flatMap(id => {
      const l = this.reg.laws.find(x => x.id === id);
      const e = this.reg.eu.find(x => x.celex === id);
      return tokenize([l?.short, ...(l?.aliases ?? []), e?.short, ...(e?.aliases ?? [])].filter(Boolean).join(' '));
    }));
    const searchGroups = groups.filter(g => !lawWords.has(g.token));
    if (searchGroups.length) groups.splice(0, groups.length, ...searchGroups);
    const euQuestion = mentioned.some(id => this.lawRow(id)?.kind === 'eu')
      || (lawIds?.every(id => this.lawRow(id)?.kind === 'eu') ?? false)
      || /(?<!\p{L})(регламент|директив|европейск|ес)(?!\p{L})/iu.test(opts.query);

    type Hit = ProvisionRow & { snippet: string; score: number };
    const run = (match: string, n: number): Hit[] => {
      const filter = lawIds ? `AND p.law_id IN (${lawIds.map(() => '?').join(',')})` : '';
      const sql = `SELECT p.id, p.law_id, p.kind, p.num, p.part, p.part_title, p.chapter, p.label, p.text,
                          snippet(provisions_fts, 0, '«', '»', ' … ', 28) AS snippet,
                          bm25(provisions_fts, 1.0, 3.0, 0.5) AS score
                     FROM provisions_fts JOIN provisions p ON p.id = provisions_fts.rowid
                    WHERE provisions_fts MATCH ? ${filter}
                    ORDER BY score LIMIT ?`;
      return this.db.prepare(sql).all(match, ...(lawIds ?? []), n) as unknown as Hit[];
    };

    // Candidate pool: all words → all but one → pairs → any word (last resort).
    const pool = new Map<number, Hit>();
    const add = (hits: Hit[]) => { for (const h of hits) if (!pool.has(h.id)) pool.set(h.id, h); };
    add(run(allOf(groups), 60));
    if (pool.size < 40 && groups.length >= 3) for (const c of combinations(groups, groups.length - 1, 12)) add(run(allOf(c), 25));
    if (pool.size < 25 && groups.length >= 2) for (const c of combinations(groups, 2, 20)) add(run(allOf(c), 15));
    if (pool.size < limit) add(run(anyOf(groups), 30));

    // Rerank: coverage of the question, match in the title/opening, named law, national law first.
    const hits = [...pool.values()];
    const maxBm = Math.max(1e-9, ...hits.map(h => -h.score));
    const ranked = hits.map(h => {
      const body = h.text.replace(/^(?:Чл\.\s*\d+[а-я]?\.|§\s*\d+[а-я]?\.|Член\s+\d+[а-я]?)\s*/u, '');
      const title = h.kind === 'art' && h.law_id.startsWith('3') ? body.split('\n')[0].replace(/^—\s*/, '') : '';
      const lead = `${title} ${body.slice(0, 220)}`;
      const cov = coverage(groups, `${h.text}\n${h.chapter ?? ''}`);
      const leadCov = coverage(groups, lead);
      const headCov = coverage(groups, `${h.chapter ?? ''} ${h.part_title ?? ''}`);
      const law = this.lawRow(h.law_id)!;
      // A provision that DEFINES the asked term („Действителен собственик“ е ...) is usually the answer.
      const defines = [...h.text.matchAll(DEFINITION)].some(m => coverage(groups, m[1]) === 1);
      const final = (-h.score / maxBm)
        + 1.5 * cov
        + 1.0 * leadCov
        + 0.4 * headCov
        + (defines ? 0.8 : 0)
        + (mentioned.includes(h.law_id) ? 0.7 : 0)
        - (law.kind === 'eu' && !euQuestion ? 0.4 : 0);
      return { h, cov, final };
    }).sort((a, b) => b.final - a.final).slice(0, limit);

    const top = ranked[0] ? { lawId: ranked[0].h.law_id, cov: ranked[0].cov } : undefined;
    const missing = this.missingRelevantLaws(opts.query, groups, mentioned, top)
      .filter(id => !lawIds || lawIds.includes(id))
      .map(id => this.lawRow(id)!);
    const coverageNote = missing.length
      ? `Probably relevant but with NO text in LexBG yet: ${missing.map(l => `${l.title} (${l.short})`).join('; ')}. Results below come from other laws; say so to the user. Amendment history is still available via what_changed.`
      : undefined;

    return {
      query: opts.query,
      coverage_note: coverageNote,
      terms: groups.map(g => g.token),
      match_mode: ranked.length && ranked[0].cov === 1 ? 'all-terms' : 'partial',
      results: ranked.map(({ h, cov }) => {
        const law = this.lawRow(h.law_id)!;
        return {
          law: law.short,
          law_id: law.id,
          law_title: law.title,
          provision: h.label,
          citation: this.citationFor(h, law.short),
          chapter: h.chapter ?? h.part_title ?? undefined,
          snippet: h.snippet,
          matched_terms: `${Math.round(cov * groups.length)}/${groups.length}`,
          text_status: law.text_status,
          warning: textWarning(law) ?? undefined,
          source_url: law.source_url,
        };
      }),
      hint: ranked.length
        ? 'Call get_provision with law + provision for the full verbatim text.'
        : 'No matches. Try other words (Bulgarian legal vocabulary works best), or check list_laws: the law text may be missing.',
    };
  }

  // ------------------------------------------------------------------ provisions

  private findProvision(lawId: string, kind: ProvisionKind, num: string, part?: PartCode): ProvisionRow | undefined {
    const n = num.toLowerCase().replace(/\s+/g, '');
    if (kind === 'art') {
      return this.db.prepare(`SELECT * FROM provisions WHERE law_id = ? AND kind = 'art' AND num = ?
                              ORDER BY CASE part WHEN 'main' THEN 0 ELSE 1 END, ord LIMIT 1`).get(lawId, n) as ProvisionRow | undefined;
    }
    if (kind === 'par') {
      if (part) {
        return this.db.prepare(`SELECT * FROM provisions WHERE law_id = ? AND kind = 'par' AND num = ? AND part = ?
                                ORDER BY ord LIMIT 1`).get(lawId, n, part) as ProvisionRow | undefined;
      }
      return this.db.prepare(`SELECT * FROM provisions WHERE law_id = ? AND kind = 'par' AND num = ?
                              ORDER BY CASE part WHEN 'main' THEN 0 WHEN 'dr' THEN 1 WHEN 'pzr' THEN 2 WHEN 'pr' THEN 3 ELSE 4 END, ord
                              LIMIT 1`).get(lawId, n) as ProvisionRow | undefined;
    }
    return this.db.prepare(`SELECT * FROM provisions WHERE law_id = ? AND kind = 'body' AND num = ? LIMIT 1`).get(lawId, n) as ProvisionRow | undefined;
  }

  getProvision(opts: { law?: string; provision: string; paragraph?: string; point?: string }) {
    const raw = opts.provision.trim();
    const withPrefix = /^\d/.test(raw) ? `чл. ${raw}` : raw;
    const c = parseCitation(`${withPrefix} ${opts.law ?? ''}`);
    if (!c) return { error: `Could not read the provision "${opts.provision}". Use e.g. "чл. 6", "6а", "§ 1 ДР".` };

    const lawInput = opts.law ?? c.lawText;
    if (!lawInput) return { error: 'Say which law, e.g. law: "ЗСч".' };
    const lawId = this.resolveLawId(lawInput);
    if (!lawId) return this.unknownLaw(lawInput);
    const law = this.lawRow(lawId)!;

    const p = this.findProvision(lawId, c.kind, c.num, c.part);
    if (!p) {
      return {
        found: false,
        law: this.lawSummary(law),
        error: law.text_status === 'missing'
          ? `There is no text for ${law.short} in the local database yet, so ${c.raw} cannot be shown.`
          : `${law.short} has no ${c.kind === 'par' ? `§ ${c.num}` : `чл. ${c.num}`} in the stored text (${law.text_status}).`,
        disclaimer: DISCLAIMER,
      };
    }

    const alineya = opts.paragraph ?? c.alineya;
    const point = opts.point ?? c.point;
    let excerpt: string | null = null;
    if (alineya) excerpt = extractParagraph(p.text, alineya);
    if (point) excerpt = extractPoint(excerpt ?? p.text, point);

    const euRefs = this.db.prepare('SELECT DISTINCT celex, citation FROM eu_refs WHERE provision_id = ?').all(p.id) as Array<{ celex: string; citation: string }>;

    return {
      found: true,
      law: this.lawSummary(law),
      provision: p.label,
      citation: this.citationFor(p, law.short, { alineya, point }),
      chapter: p.chapter ?? undefined,
      part: p.part_title ?? undefined,
      text: p.text,
      requested_excerpt: alineya || point ? excerpt ?? `(ал. ${alineya ?? '-'} / т. ${point ?? '-'} not found in this provision; full text above)` : undefined,
      eu_references: euRefs.map(e => ({ ...e, known_as: this.reg.eu.find(x => x.celex === e.celex)?.short })),
      possible_later_changes: law.kind === 'bg' && p.kind === 'art' ? this.changesMentioning(lawId, p.num, this.textDate(law)) : undefined,
      disclaimer: DISCLAIMER,
    };
  }

  private textDate(law: LawRow): string | null {
    return law.text_status === 'consolidated' ? law.retrieved_at : law.adopted;
  }

  /** Sections of amending acts (adopted after `since`) that mention "чл. N" of this law. */
  private ownNames(lawId: string): string[] {
    const l = this.reg.laws.find(x => x.id === lawId);
    return l ? [l.genitive, ...(l.genitives ?? []), l.title] : [];
  }

  private changesMentioning(lawId: string, num: string, since: string | null) {
    const own = this.ownNames(lawId);
    const acts = this.db.prepare(`SELECT a.act_id, a.title, a.adopted, a.state_gazette, a.url, m.mode, m.section_ords
                                    FROM amendments m JOIN acts a ON a.act_id = m.act_id
                                   WHERE m.law_id = ? AND m.mode != 'repeal' AND (? IS NULL OR a.adopted > ?)
                                   ORDER BY a.adopted`).all(lawId, since, since) as Array<{ act_id: number; title: string; adopted: string; state_gazette: string | null; url: string; mode: string; section_ords: string }>;
    const out: Array<{ act: string; adopted: string; state_gazette: string | null; url: string; section: string; excerpt: string }> = [];
    for (const a of acts) {
      for (const s of this.sectionsFor(a.act_id, a.mode, a.section_ords)) {
        if (mentionsProvision(withoutOwnNumber(s.text), 'art', num, own)) {
          out.push({ act: a.title, adopted: a.adopted, state_gazette: a.state_gazette, url: a.url, section: s.label, excerpt: clip(s.text, 600) });
        }
      }
    }
    return out.slice(-10);
  }

  /**
   * The sections of an act that concern the law: for indirect amendments the § that names it;
   * for amending acts everything except § that amend OTHER laws ("§ 38. В Закона за публично ...").
   */
  private sectionsFor(actId: number, mode: string, ordsJson: string) {
    const ords = JSON.parse(ordsJson) as number[];
    const all = this.db.prepare('SELECT ord, label, part, text FROM act_sections WHERE act_id = ? ORDER BY ord').all(actId) as Array<{ ord: number; label: string; part: string; text: string }>;
    if (mode === 'indirect') return all.filter(s => ords.includes(s.ord));
    return all.filter(s => !AMENDS_OTHER_LAW.test(s.text.split('\n')[0]));
  }

  validateCitation(citation: string) {
    const c = parseCitation(citation);
    if (!c) return { valid: false, reason: 'Not a recognisable citation. Expected e.g. "чл. 6, ал. 1 ЗЗЛД" or "§ 1, т. 2 от ДР на ЗСч".' };
    if (!c.lawText) return { valid: false, reason: 'The citation does not say which law.', parsed: c };
    const lawId = this.resolveLawId(c.lawText);
    if (!lawId) return { valid: false, reason: `Unknown law "${c.lawText}".`, parsed: c };
    const law = this.lawRow(lawId)!;
    if (law.text_status === 'missing') {
      return { valid: null, reason: `Cannot verify: no text for ${law.short} in the local database.`, law: this.lawSummary(law) };
    }
    const p = this.findProvision(lawId, c.kind, c.num, c.part);
    if (!p) {
      return { valid: false, reason: `${law.short} (${law.text_status} text) has no such provision.`, law: this.lawSummary(law), parsed: c };
    }
    let sub: string | null = p.text;
    if (c.alineya) sub = extractParagraph(p.text, c.alineya);
    if (sub && c.point) sub = extractPoint(sub, c.point);
    const valid = Boolean(sub);
    return {
      valid,
      normalized: this.citationFor(p, law.short, { alineya: c.alineya, point: c.point }),
      reason: valid ? 'Provision found in the stored text.' : `${p.label} exists, but ${c.alineya ? `ал. ${c.alineya}` : ''}${c.point ? ` т. ${c.point}` : ''} was not found in it.`,
      text: valid ? clip(sub!, 1500) : undefined,
      law: this.lawSummary(law),
    };
  }

  // ------------------------------------------------------------------ amendments

  whatChanged(opts: { law: string; since?: string; until?: string; article?: string; limit?: number; include_text?: boolean }) {
    const lawId = this.resolveLawId(opts.law);
    if (!lawId) return this.unknownLaw(opts.law);
    const law = this.lawRow(lawId)!;
    if (law.kind !== 'bg') return { error: 'what_changed tracks Bulgarian laws (amendments published in the State Gazette).' };

    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    // By default count only changes since the current law was adopted: older acts with the same
    // title amended a predecessor law (e.g. the Accounting Act of 2001, replaced in 2015).
    const since = opts.since ?? law.adopted ?? null;
    const olderCount = !opts.since && law.adopted
      ? (this.db.prepare(`SELECT COUNT(*) AS n FROM amendments m JOIN acts a ON a.act_id = m.act_id
                           WHERE m.law_id = ? AND a.adopted < ?`).get(lawId, law.adopted) as { n: number }).n
      : 0;
    const until = opts.until ?? null;
    const acts = this.db.prepare(`SELECT a.act_id, a.title, a.adopted, a.state_gazette, a.url, m.mode, m.section_ords
                                    FROM amendments m JOIN acts a ON a.act_id = m.act_id
                                   WHERE m.law_id = ?
                                     AND (? IS NULL OR a.adopted >= ?)
                                     AND (? IS NULL OR a.adopted <= ?)
                                   ORDER BY a.adopted DESC`).all(lawId, since, since, until, until) as Array<{ act_id: number; title: string; adopted: string; state_gazette: string | null; url: string; mode: string; section_ords: string }>;

    // "38" / "чл. 38" → mentions of чл. 38 of THIS law; "§ 1" → mentions of § 1 (not the section's own number).
    const own = this.ownNames(lawId);
    const target = opts.article?.trim();
    const filterKind: 'art' | 'par' = target?.startsWith('§') ? 'par' : 'art';
    const filterNum = target?.replace(/^(?:чл\.?|§)\s*/iu, '').replace(/,.*$/, '').trim();

    const items = [];
    for (const a of acts) {
      let sections = this.sectionsFor(a.act_id, a.mode, a.section_ords);
      if (filterNum) sections = sections.filter(s => mentionsProvision(withoutOwnNumber(s.text), filterKind, filterNum, own));
      if (filterNum && sections.length === 0) continue;
      items.push({
        act: a.title,
        adopted: a.adopted,
        state_gazette: a.state_gazette ?? undefined,
        how: a.mode === 'direct' ? 'amending act for this law' : a.mode === 'repeal' ? 'repeals this law' : 'amended by a provision inside another act',
        url: a.url,
        sections: opts.include_text === false ? sections.map(s => s.label) : sections.slice(0, 12).map(s => ({ section: s.label, text: clip(s.text, 1200) })),
        more_sections: sections.length > 12 ? sections.length - 12 : undefined,
      });
      if (items.length >= limit) break;
    }

    return {
      law: this.lawSummary(law),
      filter: { since, until, article: opts.article ?? null },
      total_amending_acts: acts.length,
      earlier_acts_excluded: olderCount
        ? `${olderCount} earlier act(s) amended a previous law with the same title (before ${law.adopted}). Pass since: "2000-01-01" to include them.`
        : undefined,
      changes: items,
      note: 'Dates are adoption dates by the National Assembly; publication (ДВ) follows within days and entry into force may differ (see each act\'s final provisions). Amendments are detected from parliament.bg act titles and from "В Закона за ..." clauses inside other acts.',
      disclaimer: DISCLAIMER,
    };
  }

  // ------------------------------------------------------------------ EU links

  euLinks(opts: { law?: string; eu_act?: string; limit?: number }) {
    const limit = Math.min(opts.limit ?? 30, 100);
    if (opts.eu_act) {
      const eu = resolveEu(this.reg, opts.eu_act);
      const celex = eu?.celex ?? (/^3\d{4}[RL]\d{4}$/i.test(opts.eu_act.trim()) ? opts.eu_act.trim().toUpperCase() : null);
      if (!celex) return { error: `Unknown EU act "${opts.eu_act}". Use a CELEX number (e.g. 32016R0679) or a short name: ${this.reg.eu.map(e => e.short).join(', ')}.` };
      const rows = this.db.prepare(`SELECT r.law_id, p.kind, p.num, p.part, p.label, r.citation
                                      FROM eu_refs r JOIN provisions p ON p.id = r.provision_id
                                     WHERE r.celex = ? AND r.law_id != ?
                                     ORDER BY r.law_id, p.ord LIMIT ?`).all(celex, celex, limit) as Array<{ law_id: string; kind: ProvisionKind; num: string; part: PartCode; label: string; citation: string }>;
      return {
        eu_act: { celex, short: eu?.short, title: this.lawRow(celex)?.title ?? eu?.title, url: `https://eur-lex.europa.eu/legal-content/BG/TXT/?uri=CELEX:${celex}` },
        bulgarian_provisions_referencing_it: rows.map(r => {
          const law = this.lawRow(r.law_id)!;
          return { law: law.short, provision: r.label, citation: this.citationFor(r, law.short), mentioned_as: r.citation };
        }),
        note: 'Found by scanning the stored Bulgarian texts for references like "Регламент (ЕС) 2016/679". Laws without stored text are not covered.',
      };
    }
    if (opts.law) {
      const lawId = this.resolveLawId(opts.law);
      if (!lawId) return this.unknownLaw(opts.law);
      const law = this.lawRow(lawId)!;
      const rows = this.db.prepare(`SELECT celex, COUNT(*) AS mentions, MIN(citation) AS example
                                      FROM eu_refs WHERE law_id = ? GROUP BY celex ORDER BY mentions DESC LIMIT ?`).all(lawId, limit) as Array<{ celex: string; mentions: number; example: string }>;
      return {
        law: this.lawSummary(law),
        eu_acts_referenced: rows.map(r => ({
          celex: r.celex,
          known_as: this.reg.eu.find(e => e.celex === r.celex)?.short,
          mentions: r.mentions,
          example: r.example,
          url: `https://eur-lex.europa.eu/legal-content/BG/TXT/?uri=CELEX:${r.celex}`,
          text_in_lexbg: this.lawRow(r.celex)?.text_status === 'original',
        })),
      };
    }
    return { error: 'Pass either law (e.g. "ЗЗЛД") or eu_act (e.g. "GDPR").' };
  }

  // ------------------------------------------------------------------ topics & checklist

  private topicProvisions(t: TopicEntry, perQuery: number) {
    const seen = new Set<string>();
    const out: Array<{ query: string; law: string; provision: string; citation: string; snippet: string; warning?: string }> = [];
    for (const query of t.queries) {
      const res = this.search({ query, topic: t.id, limit: perQuery + 2 });
      if ('error' in res) continue;
      let added = 0;
      for (const r of res.results) {
        const key = `${r.law_id}|${r.provision}`;
        if (seen.has(key) || added >= perQuery) continue;
        seen.add(key);
        added += 1;
        out.push({ query, law: r.law, provision: r.provision, citation: r.citation, snippet: r.snippet, warning: r.warning });
      }
    }
    return out;
  }

  private topicLaws(t: TopicEntry) {
    return [...t.laws, ...t.eu].map(id => this.lawRow(id)).filter((x): x is LawRow => Boolean(x)).map(l => this.lawSummary(l));
  }

  getTopic(opts: { topic: string; per_query?: number }) {
    const t = resolveTopic(this.reg, opts.topic);
    if (!t) return { error: `Unknown topic "${opts.topic}". Topics: ${this.reg.topics.map(x => `${x.id} (${x.title})`).join(', ')}` };
    return {
      topic: { id: t.id, title: t.title, title_en: t.title_en, summary: t.summary },
      laws: this.topicLaws(t),
      typical_questions: t.questions,
      key_provisions: this.topicProvisions(t, opts.per_query ?? 2),
      how_to_use: 'These provisions were retrieved by keyword search for the topic\'s standard questions. Open them with get_provision and read them in full before relying on them.',
      disclaimer: DISCLAIMER,
    };
  }

  checklist(profile: Profile) {
    const matched: Array<{ topic: TopicEntry; reasons: string[] }> = [];
    const skipped: Array<{ id: string; title: string }> = [];
    for (const t of this.reg.topics) {
      const reasons = t.applies_if.map(c => matchCondition(c, profile)).filter((r): r is string => Boolean(r));
      if (reasons.length) matched.push({ topic: t, reasons });
      else skipped.push({ id: t.id, title: t.title });
    }
    return {
      profile,
      applicable_topics: matched.map(({ topic, reasons }) => ({
        id: topic.id,
        title: topic.title,
        title_en: topic.title_en,
        why: reasons,
        summary: topic.summary,
        laws: this.topicLaws(topic),
        questions_to_check: topic.questions,
        key_provisions: this.topicProvisions(topic, 1),
      })),
      not_applicable_based_on_profile: skipped,
      gaps: matched.flatMap(m => this.topicLaws(m.topic)).filter(l => l.text_status === 'missing').map(l => `${l.short}: no text in local database`)
        .filter((v, i, a) => a.indexOf(v) === i),
      how_to_use: 'This is a map of the law areas that likely apply, with the provisions to read first. It does not decide whether an obligation applies to you — thresholds, exceptions and deadlines must be read in the full text.',
      disclaimer: DISCLAIMER,
    };
  }

  // ------------------------------------------------------------------ obligations

  getObligations(opts: { law: string; provision?: string; include_unreviewed?: boolean }) {
    const lawId = this.resolveLawId(opts.law);
    if (!lawId) return this.unknownLaw(opts.law);
    const law = this.lawRow(lawId)!;
    const statuses = opts.include_unreviewed === false ? ['approved'] : ['approved', 'unreviewed'];
    const rows = this.db.prepare(`SELECT o.subject, o.action, o.deadline, o.quote, o.review_status, o.model,
                                         p.kind, p.num, p.part, p.label
                                    FROM obligations o JOIN provisions p ON p.id = o.provision_id
                                   WHERE o.law_id = ? AND o.review_status IN (${statuses.map(() => '?').join(',')})
                                   ORDER BY p.ord`).all(lawId, ...statuses) as Array<{ subject: string; action: string; deadline: string | null; quote: string; review_status: string; model: string | null; kind: ProvisionKind; num: string; part: PartCode; label: string }>;
    const filtered = opts.provision ? rows.filter(r => r.label.toLowerCase() === opts.provision!.toLowerCase().replace(/^(\d)/, 'чл. $1')) : rows;
    return {
      law: this.lawSummary(law),
      obligations: filtered.map(r => ({
        who: r.subject,
        must: r.action,
        deadline: r.deadline ?? undefined,
        citation: this.citationFor(r, law.short),
        quote: r.quote,
        review_status: r.review_status,
      })),
      note: rows.length
        ? 'Extracted with an LLM; every quote was verified to appear verbatim in the provision. "unreviewed" items have not been checked by a person.'
        : `No obligations extracted for ${law.short} yet. Run: npm run extract:obligations -- --law ${law.id}`,
      disclaimer: DISCLAIMER,
    };
  }
}

export interface Profile {
  entity_type?: string;
  has_employees?: boolean;
  processes_personal_data?: boolean;
  sells_to_consumers?: boolean;
  sells_online?: boolean;
  vat_status?: 'registered' | 'not_registered' | 'unsure';
  aml_obliged?: 'yes' | 'no' | 'unsure';
  sector?: string[];
}

function matchCondition(c: Condition, p: Profile): string | null {
  if (c.always) return 'applies to everyone';
  if (c.entity_type && p.entity_type && c.entity_type.includes(p.entity_type)) return `entity type is ${p.entity_type}`;
  if (c.has_employees && p.has_employees) return 'you have employees';
  if (c.processes_personal_data && p.processes_personal_data) return 'you process personal data';
  if (c.sells_to_consumers && p.sells_to_consumers) return 'you sell to consumers';
  if (c.sells_online && p.sells_online) return 'you sell online';
  if (c.vat_status && p.vat_status && c.vat_status.includes(p.vat_status)) return `VAT status: ${p.vat_status}`;
  if (c.aml_obliged && p.aml_obliged && c.aml_obliged.includes(p.aml_obliged)) return `AML obligated entity: ${p.aml_obliged}`;
  if (c.sector && p.sector?.some(s => c.sector!.includes(s))) return `sector: ${p.sector.filter(s => c.sector!.includes(s)).join(', ')}`;
  return null;
}

const AMENDS_OTHER_LAW =
  /^(?:§|Чл\.)\s*\d+[а-я]?\.\s*(?:\(\d+\)\s*)?В\s+(?:[^;()]{0,120}?\s+от\s+)?(?:Закона|Кодекса|Търговския|Данъчно|Изборния|Наказателния|Граждански|Административнопроцесуалния|Конституцията|Семейния|Наказателно)/u;

/** Quoted term followed by a defining verb: „Действителен собственик“ е ..., 2. „Група предприятия“ са ... */
const DEFINITION = /„([^“]{2,120})“\s*(?:е|са|означава|се разбира|има значение)(?![\p{L}])/gu;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)} …`;
}
