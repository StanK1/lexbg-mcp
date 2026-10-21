/**
 * Coverage report: which laws have current text, which only have the original act,
 * and which are missing — so gaps are visible instead of silently returning stale text.
 */
import * as fs from 'node:fs';
import type { Db } from './db.js';

export interface LawCoverage {
  id: string;
  kind: 'bg' | 'eu';
  short: string;
  title: string;
  text_status: 'consolidated' | 'original' | 'missing';
  provision_count: number;
  amendments_total: number;
  amendments_after_text: number;
  last_amended: string | null;
  retrieved_at: string | null;
  adopted: string | null;
  state_gazette: string | null;
  status: string;
}

export function getCoverage(db: Db): LawCoverage[] {
  return db.prepare(`SELECT id, kind, short, title, text_status, provision_count, amendments_total,
                            amendments_after_text, last_amended, retrieved_at, adopted, state_gazette, status
                       FROM laws ORDER BY kind, short`).all() as unknown as LawCoverage[];
}

export function textWarning(l: Pick<LawCoverage, 'text_status' | 'amendments_after_text' | 'retrieved_at' | 'adopted' | 'state_gazette' | 'kind'>): string | null {
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
  return l.amendments_after_text > 0
    ? `Consolidated text current as of ${l.retrieved_at}. ${l.amendments_after_text} amending act(s) adopted since then are NOT applied. Use what_changed.`
    : `Consolidated text current as of ${l.retrieved_at}.`;
}

export function writeCoverageReport(db: Db, file: string): { summary: string } {
  const rows = getCoverage(db);
  const bg = rows.filter(r => r.kind === 'bg');
  const eu = rows.filter(r => r.kind === 'eu');
  const count = (s: string, list: LawCoverage[]) => list.filter(r => r.text_status === s).length;

  const lines = [
    '# LexBG coverage report',
    '',
    `Generated ${new Date().toISOString()}.`,
    '',
    `Bulgarian laws: ${bg.length} tracked — ${count('consolidated', bg)} consolidated, ${count('original', bg)} original text only, ${count('missing', bg)} missing text.`,
    `EU acts: ${eu.length} tracked — ${eu.length - count('missing', eu)} with text, ${count('missing', eu)} missing.`,
    '',
    '| Law | Text | Provisions | Amendments (total / not applied) | Last amended |',
    '|---|---|---:|---:|---|',
    ...rows.map(r =>
      `| ${r.short} — ${r.title} | ${r.text_status}${r.status === 'repealed' ? ' (repealed)' : ''} | ${r.provision_count} | ${r.kind === 'bg' ? `${r.amendments_total} / ${r.amendments_after_text}` : '–'} | ${r.last_amended ?? '–'} |`),
    '',
    'To add a consolidated text for a "missing" or "original" law, see DATA_SOURCES.md → Adding a consolidated text.',
    '',
  ];
  fs.writeFileSync(file, lines.join('\n'));
  const summary = `Coverage: ${count('consolidated', bg)} consolidated, ${count('original', bg)} original-only, ${count('missing', bg)} missing (of ${bg.length} Bulgarian laws); ${eu.length - count('missing', eu)}/${eu.length} EU acts. Report: ${file}`;
  return { summary };
}
