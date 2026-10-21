#!/usr/bin/env tsx
/**
 * Retrieval evaluation: for each question, is the correct provision among the top-k search results?
 * Deterministic (no LLM), so it runs in CI and shows whether a search change helps or hurts.
 *
 *   npm run eval                                   # evals/retrieval.yml against data/lexbg.db
 *   npm run eval -- --file evals/fixtures.yml --db path/to/fixtures.db
 *   npm run eval -- --min-hit5 0.8                 # exit 1 if hit@5 drops below 0.8 (CI gate)
 */
import '../src/quiet.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { defaultDbPath, openDb } from '../src/db.js';
import { loadRegistry } from '../src/registry.js';
import { LexBG } from '../src/service.js';
import { parseCitation, formatCitation } from '../src/text/citation.js';
import { ROOT, argValue } from './lib/paths.js';

interface Case { id: string; question: string; law?: string; expect: string[] }

export interface EvalResult {
  cases: number;
  hit1: number;
  hit3: number;
  hit5: number;
  mrr: number;
  rows: Array<{ id: string; rank: number | null; top: string[] }>;
}

/** Normalise a citation to "<provision> <law>" without алинея/точка, e.g. "чл. 12 ЗСч", "§ 1 от ДР на ЗСч". */
function key(lex: LexBG, citation: string): string {
  const c = parseCitation(citation);
  if (!c) return citation.trim();
  const lawId = lex.resolveLawId(c.lawText) ?? c.lawText;
  return `${formatCitation({ kind: c.kind, num: c.num, part: c.part }, lawId)}`;
}

export function runEval(lex: LexBG, cases: Case[], k = 10): EvalResult {
  const rows: EvalResult['rows'] = [];
  for (const c of cases) {
    const res = lex.search({ query: c.question, law: c.law, limit: k });
    const results = 'error' in res ? [] : res.results;
    const expected = new Set(c.expect.map(e => key(lex, e)));
    const keys = results.map(r => key(lex, r.citation));
    const idx = keys.findIndex(x => expected.has(x));
    rows.push({ id: c.id, rank: idx === -1 ? null : idx + 1, top: results.slice(0, 3).map(r => r.citation) });
  }
  const at = (n: number) => rows.filter(r => r.rank !== null && r.rank <= n).length / rows.length;
  const mrr = rows.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / rows.length;
  return { cases: rows.length, hit1: at(1), hit3: at(3), hit5: at(5), mrr, rows };
}

function main(): void {
  const file = path.resolve(ROOT, argValue('--file') ?? 'evals/retrieval.yml');
  const dbFile = path.resolve(argValue('--db') ?? defaultDbPath());
  const cases = (YAML.parse(fs.readFileSync(file, 'utf8')) as { cases: Case[] }).cases;
  const lex = new LexBG(openDb(dbFile, { readOnly: true }), loadRegistry());
  const r = runEval(lex, cases);

  for (const row of r.rows) {
    const mark = row.rank === null ? '✗ miss ' : row.rank <= 3 ? `✓ @${row.rank}   ` : `~ @${row.rank}   `;
    console.log(`${mark} ${row.id.padEnd(32)} top: ${row.top.join(' | ')}`);
  }
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  console.log(`\n${r.cases} cases — hit@1 ${pct(r.hit1)} · hit@3 ${pct(r.hit3)} · hit@5 ${pct(r.hit5)} · MRR ${r.mrr.toFixed(2)}`);

  const report = path.join(ROOT, 'data', 'eval-report.json');
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(report, JSON.stringify({ file: path.relative(ROOT, file), at: new Date().toISOString(), ...r }, null, 2));

  const min = argValue('--min-hit5');
  if (min && r.hit5 < Number(min)) {
    console.error(`hit@5 ${pct(r.hit5)} is below the required ${pct(Number(min))}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
