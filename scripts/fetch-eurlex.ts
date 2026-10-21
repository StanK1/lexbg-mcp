#!/usr/bin/env tsx
/**
 * Download the Bulgarian-language text of the EU acts listed in sources/eu.yml into
 * data/raw/eurlex/<CELEX>.html.
 *
 * 1. Cellar — the Publications Office's machine API (content negotiation on the CELEX URI).
 *    This is the official way to fetch EU law programmatically.
 * 2. Fallback: the EUR-Lex HTML page (often blocked for scripts by a bot-protection page).
 *
 * EUR-Lex/Cellar content may be reused free of charge, with attribution:
 * © European Union, https://eur-lex.europa.eu
 *
 *   npm run fetch:eurlex
 *   npm run fetch:eurlex -- --only 32016R0679 --force
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PoliteFetcher } from './lib/http.js';
import { argValue, hasFlag, paths } from './lib/paths.js';
import { loadRegistry } from '../src/registry.js';

const looksLikeAct = (html: string) => /Член\s*(?:<[^>]+>\s*)*1\b/u.test(html) || /Член\s+1/u.test(html);

async function viaCellar(http: PoliteFetcher, celex: string): Promise<string> {
  return http.text(`https://publications.europa.eu/resource/celex/${celex}`,
    'application/xhtml+xml, text/html;q=0.9', { 'Accept-Language': 'bul' });
}

async function viaEurLex(http: PoliteFetcher, celex: string): Promise<string> {
  return http.text(`https://eur-lex.europa.eu/legal-content/BG/TXT/HTML/?uri=CELEX:${celex}`);
}

async function main(): Promise<void> {
  const reg = loadRegistry();
  const http = new PoliteFetcher({ minDelayMs: 2000, timeoutMs: 90000, retries: 1 });
  const only = argValue('--only');
  const force = hasFlag('--force');
  fs.mkdirSync(paths.eurlex, { recursive: true });

  let saved = 0;
  const failed: string[] = [];
  for (const e of reg.eu.filter(x => !only || x.celex === only)) {
    const file = path.join(paths.eurlex, `${e.celex}.html`);
    if (fs.existsSync(file) && !force) {
      console.log(`  ${e.celex} ${e.short}: already downloaded`);
      continue;
    }
    let html: string | null = null;
    const notes: string[] = [];
    for (const [name, fn] of [['Cellar', viaCellar], ['EUR-Lex', viaEurLex]] as const) {
      try {
        const body = await fn(http, e.celex);
        if (looksLikeAct(body)) { html = body; notes.push(`via ${name}`); break; }
        notes.push(`${name}: no act text (${body.length} bytes)`);
      } catch (err) {
        notes.push(`${name}: ${(err as Error).message}`);
      }
    }
    if (html) {
      fs.writeFileSync(file, html);
      saved += 1;
      console.log(`  ${e.celex} ${e.short}: saved ${Math.round(html.length / 1024)} KB ${notes.at(-1)}`);
    } else {
      failed.push(e.celex);
      console.warn(`  ${e.celex} ${e.short}: FAILED — ${notes.join('; ')}`);
    }
  }
  console.log(`Done: ${saved} saved, ${failed.length} failed.`);
  if (failed.length) {
    console.log('For failed acts: open https://eur-lex.europa.eu/legal-content/BG/TXT/HTML/?uri=CELEX:<CELEX> in a browser,');
    console.log(`save as "Web page, HTML only" to ${paths.eurlex}/<CELEX>.html, then run npm run build:db.`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
