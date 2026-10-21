#!/usr/bin/env tsx
/** Print the coverage table and write data/coverage.md.   npm run coverage */
import '../src/quiet.js';
import * as path from 'node:path';
import { defaultDbPath, openDb } from '../src/db.js';
import { getCoverage, writeCoverageReport } from '../src/coverage.js';

const file = defaultDbPath();
const db = openDb(file, { readOnly: true });
const rows = getCoverage(db);
const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));

console.log(`${pad('LAW', 12)} ${pad('TEXT', 13)} ${pad('PROV', 6)} ${pad('AMEND (not applied)', 20)} LAST AMENDED`);
for (const r of rows) {
  const amend = r.kind === 'bg' ? `${r.amendments_total} (${r.amendments_after_text})` : '–';
  console.log(`${pad(r.short, 12)} ${pad(r.text_status + (r.status === 'repealed' ? '*' : ''), 13)} ${pad(String(r.provision_count), 6)} ${pad(amend, 20)} ${r.last_amended ?? '–'}`);
}
const { summary } = writeCoverageReport(db, path.join(path.dirname(file), 'coverage.md'));
console.log(`\n${summary}`);
const todo = rows.filter(r => r.kind === 'bg' && r.text_status !== 'consolidated').map(r => r.short);
if (todo.length) {
  console.log(`\nNext: add consolidated texts for ${todo.slice(0, 8).join(', ')}${todo.length > 8 ? ' …' : ''} (DATA_SOURCES.md).`);
}
db.close();
