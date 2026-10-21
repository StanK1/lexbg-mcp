#!/usr/bin/env tsx
/**
 * Download the catalogue and texts of acts promulgated by the Bulgarian National Assembly
 * from parliament.bg into data/raw/parliament/. Resumable: already-downloaded acts are skipped.
 *
 *   npm run fetch:parliament                     # everything (≈ 40–60 min, polite 1.2 s delay)
 *   npm run fetch:parliament -- --only-tracked   # only acts whose TITLE matches a tracked law (fast)
 *   npm run fetch:parliament -- --since 2018     # only acts promulgated from 2018 on
 *   npm run fetch:parliament -- --limit 50       # first 50 acts (smoke test)
 *   npm run fetch:parliament -- --refresh        # re-download the catalogue (new acts)
 *
 * Endpoints (public JSON used by parliament.bg's own website; undocumented, may change):
 *   /api/v1/archive-list/bg/L_Acts_fn/1/0
 *   /api/v1/archive-period/bg/L_Acts_fn/{year}/{month}/1/0
 *   /api/v1/act/{id}
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PoliteFetcher } from './lib/http.js';
import { argValue, hasFlag, paths } from './lib/paths.js';
import { loadRegistry } from '../src/registry.js';
import { titleIsTracked } from '../src/amendments.js';

const BASE = 'https://www.parliament.bg/api/v1';

export interface CatalogEntry {
  t_id: number;
  t_date: string;
  t_label: string;
}

interface ArchiveYear {
  t_year: number;
  t_month_list: Array<{ t_month: number }>;
}

async function discover(http: PoliteFetcher, sinceYear: number | null): Promise<CatalogEntry[]> {
  const years = await http.json<ArchiveYear[]>(`${BASE}/archive-list/bg/L_Acts_fn/1/0`);
  const byId = new Map<number, CatalogEntry>();
  for (const y of years) {
    if (sinceYear && y.t_year < sinceYear) continue;
    for (const m of y.t_month_list) {
      try {
        const entries = await http.json<CatalogEntry[]>(`${BASE}/archive-period/bg/L_Acts_fn/${y.t_year}/${m.t_month}/1/0`);
        for (const e of entries) byId.set(e.t_id, e);
        process.stdout.write(`  catalogue ${y.t_year}-${String(m.t_month).padStart(2, '0')}: ${entries.length} acts\n`);
      } catch (err) {
        console.warn(`  catalogue ${y.t_year}-${m.t_month}: FAILED (${(err as Error).message})`);
      }
    }
  }
  return [...byId.values()].sort((a, b) => a.t_date.localeCompare(b.t_date) || a.t_id - b.t_id);
}

async function main(): Promise<void> {
  const reg = loadRegistry();
  const http = new PoliteFetcher({ minDelayMs: Number(argValue('--delay') ?? 1200) });
  const limit = argValue('--limit') ? Number(argValue('--limit')) : null;
  const since = argValue('--since') ? Number(argValue('--since')) : null;
  const onlyTracked = hasFlag('--only-tracked');

  fs.mkdirSync(paths.parliamentActs, { recursive: true });

  let catalog: CatalogEntry[];
  if (fs.existsSync(paths.catalog) && !hasFlag('--refresh')) {
    catalog = JSON.parse(fs.readFileSync(paths.catalog, 'utf8')) as CatalogEntry[];
    console.log(`Using existing catalogue (${catalog.length} acts). Pass --refresh to update it.`);
  } else {
    console.log('Discovering the catalogue of promulgated acts on parliament.bg ...');
    const found = await discover(http, since);
    // Merge with an existing catalogue so --since runs don't drop older entries.
    const merged = new Map<number, CatalogEntry>();
    if (fs.existsSync(paths.catalog)) {
      for (const e of JSON.parse(fs.readFileSync(paths.catalog, 'utf8')) as CatalogEntry[]) merged.set(e.t_id, e);
    }
    for (const e of found) merged.set(e.t_id, e);
    catalog = [...merged.values()].sort((a, b) => a.t_date.localeCompare(b.t_date) || a.t_id - b.t_id);
    fs.writeFileSync(paths.catalog, JSON.stringify(catalog, null, 2));
    console.log(`Catalogue saved: ${catalog.length} acts → ${path.relative(process.cwd(), paths.catalog)}`);
  }

  let todo = catalog.filter(e => !since || Number(e.t_date.slice(0, 4)) >= since);
  if (onlyTracked) todo = todo.filter(e => titleIsTracked(e.t_label, reg.laws));
  todo = todo.filter(e => !fs.existsSync(path.join(paths.parliamentActs, `${e.t_id}.json`)));
  if (limit) todo = todo.slice(0, limit);

  const minutes = Math.ceil((todo.length * 1.3) / 60);
  console.log(`Downloading ${todo.length} act texts (≈ ${minutes} min). Safe to stop and resume.`);

  let ok = 0;
  let failed = 0;
  for (const [i, e] of todo.entries()) {
    try {
      const act = await http.json<Record<string, unknown>>(`${BASE}/act/${e.t_id}`);
      if (!act || typeof act.L_ActL_final_body !== 'string') throw new Error('response has no act body');
      fs.writeFileSync(path.join(paths.parliamentActs, `${e.t_id}.json`), JSON.stringify(act));
      ok += 1;
    } catch (err) {
      failed += 1;
      console.warn(`  act ${e.t_id} (${e.t_label.slice(0, 60)}): ${(err as Error).message}`);
    }
    if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${todo.length} done`);
  }
  console.log(`Finished: ${ok} downloaded, ${failed} failed. Next: npm run build:db`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
