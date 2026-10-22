/**
 * Coverage report: which laws have current text, which only have the original act,
 * and which are missing — so gaps are visible instead of silently returning stale text.
 */
import * as fs from 'node:fs';
import type { Db } from './db.js';

export type TextStatus = 'consolidated' | 'compiled' | 'original' | 'missing';

export interface LawCoverage {
  id: string;
  kind: 'bg' | 'eu';
  short: string;
  title: string;
  text_status: TextStatus;
  provision_count: number;
  amendments_total: number;
  amendments_after_text: number;
  last_amended: string | null;
  retrieved_at: string | null;
  adopted: string | null;
  state_gazette: string | null;
  status: string;
  compiled_through: string | null;
  compile_applied: number;
  compile_failed: number;
  compile_pending: number;
  compile_missing: string;
  compile_mentioned: string;
}

export function getCoverage(db: Db): LawCoverage[] {
  return db.prepare(`SELECT id, kind, short, title, text_status, provision_count, amendments_total,
                            amendments_after_text, last_amended, retrieved_at, adopted, state_gazette, status,
                            compiled_through, compile_applied, compile_failed, compile_pending, compile_missing, compile_mentioned
                       FROM laws ORDER BY kind, short`).all() as unknown as LawCoverage[];
}

type WarningInput = Pick<LawCoverage, 'text_status' | 'amendments_after_text' | 'retrieved_at' | 'adopted' | 'state_gazette' | 'kind'>
  & Partial<Pick<LawCoverage, 'compiled_through' | 'compile_failed' | 'compile_pending' | 'compile_missing'>>;

function issues(json: string | undefined): string[] {
  try {
    return JSON.parse(json ?? '[]') as string[];
  } catch {
    return [];
  }
}

export function textWarning(l: WarningInput): string | null {
  if (l.kind === 'eu') return 'Original Official Journal text; later amendments of the EU act are not applied.';
  if (l.text_status === 'missing') {
    return 'No text for this law in the local database yet (see DATA_SOURCES.md). Amendment history is still available.';
  }
  if (l.text_status === 'original') {
    const when = `adopted ${l.adopted}${l.state_gazette ? `, ${l.state_gazette}` : ''}`;
    return l.amendments_after_text > 0
      ? `Original text (${when}). ${l.amendments_after_text} later amending act(s) are NOT applied — the current wording may differ. Use what_changed.`
      : `Original text (${when}); no later amendments found in the local catalogue.`;
  }
  if (l.text_status === 'compiled') {
    const parts = [
      `Current text compiled by LexBG: the original (${l.state_gazette ?? `adopted ${l.adopted}`}) with the amending acts applied in order of entry into force, through ${l.compiled_through ?? 'the latest act in the catalogue'}`.replace(/\.?$/u, '.'),
    ];
    if (l.compile_failed) parts.push(`${l.compile_failed} amending instruction(s) could not be applied automatically — get_provision lists them for the provisions concerned.`);
    const missing = issues(l.compile_missing);
    if (missing.length) parts.push(`Amendments in ДВ бр. ${missing.join(', ')} are listed in the State Gazette but not in LexBG's catalogue, so their changes are missing.`);
    if (l.compile_pending) parts.push(`${l.compile_pending} change(s) take effect later and are not applied yet.`);
    parts.push('Not an official consolidated text: verify important wording in Държавен вестник.');
    return parts.join(' ');
  }
  return l.amendments_after_text > 0
    ? `Consolidated text current as of ${l.retrieved_at}. ${l.amendments_after_text} amending act(s) adopted since then are NOT applied. Use what_changed.`
    : `Consolidated text current as of ${l.retrieved_at}.`;
}

export function writeCoverageReport(db: Db, file: string): { summary: string } {
  const rows = getCoverage(db);
  const bg = rows.filter(r => r.kind === 'bg');
  const eu = rows.filter(r => r.kind === 'eu');
  const count = (s: string, list: LawCoverage[]) => list.filter(r => r.text_status === s).length;
  const textCell = (r: LawCoverage) => {
    let s: string = r.text_status;
    if (r.text_status === 'compiled') {
      s += ` (${r.compile_applied} applied${r.compile_failed ? `, ${r.compile_failed} not applied` : ''}${r.compile_pending ? `, ${r.compile_pending} pending` : ''})`;
      const missing = issues(r.compile_missing);
      if (missing.length) s += ` — missing ДВ ${missing.join(', ')}`;
    }
    return `${s}${r.status === 'repealed' ? ' (repealed)' : ''}`;
  };

  const lines = [
    '# LexBG coverage report',
    '',
    `Generated ${new Date().toISOString()}.`,
    '',
    `Bulgarian laws: ${bg.length} tracked — ${count('consolidated', bg)} consolidated, ${count('compiled', bg)} compiled by LexBG, ${count('original', bg)} original text only, ${count('missing', bg)} missing text.`,
    `EU acts: ${eu.length} tracked — ${eu.length - count('missing', eu)} with text, ${count('missing', eu)} missing.`,
    '',
    '"compiled" = LexBG applied the amending acts to the original text itself; "applied / not applied" counts amending instructions.',
    '',
    '| Law | Text | Provisions | Amending acts | Last amended |',
    '|---|---|---:|---:|---|',
    ...rows.map(r =>
      `| ${r.short} — ${r.title} | ${textCell(r)} | ${r.provision_count} | ${r.kind === 'bg' ? r.amendments_total : '–'} | ${r.last_amended ?? '–'} |`),
    '',
    'To add a consolidated text for a "missing" or "original" law, see DATA_SOURCES.md → Adding a consolidated text.',
    '',
  ];
  fs.writeFileSync(file, lines.join('\n'));
  const summary = `Coverage: ${count('consolidated', bg)} consolidated, ${count('compiled', bg)} compiled, ${count('original', bg)} original-only, ${count('missing', bg)} missing (of ${bg.length} Bulgarian laws); ${eu.length - count('missing', eu)}/${eu.length} EU acts. Report: ${file}`;
  return { summary };
}
