#!/usr/bin/env tsx
/**
 * Download the Bulgarian-language text of the EU acts listed in sources/eu.yml from EUR-Lex
 * into data/raw/eurlex/<CELEX>.html. EUR-Lex content may be reused free of charge
 * (see https://eur-lex.europa.eu/content/legal-notice/legal-notice.html).
 *
 *   npm run fetch:eurlex
 *   npm run fetch:eurlex -- --only 32016R0679 --force
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PoliteFetcher } from './lib/http.js';
import { argValue, hasFlag, paths } from './lib/paths.js';
import { loadRegistry } from '../src/registry.js';

function urlFor(celex: string): string {
  return `https://eur-lex.europa.eu/legal-content/BG/TXT/HTML/?uri=CELEX:${celex}`;
}

async function main(): Promise<void> {
  const reg = loadRegistry();
  const http = new PoliteFetcher({ minDelayMs: 2000, timeoutMs: 60000 });
  const only = argValue('--only');
  const force = hasFlag('--force');
  fs.mkdirSync(paths.eurlex, { recursive: true });

  const acts = reg.eu.filter(e => !only || e.celex === only);
  for (const e of acts) {
    const file = path.join(paths.eurlex, `${e.celex}.html`);
    if (fs.existsSync(file) && !force) {
      console.log(`  ${e.celex} ${e.short}: already downloaded`);
      continue;
    }
    try {
      const html = await http.text(urlFor(e.celex));
      if (!/Член\s+1/u.test(html)) {
        console.warn(`  ${e.celex} ${e.short}: page has no "Член 1" — EUR-Lex may have served a cookie/captcha page. Try again later or download it in a browser and save it as ${file}`);
        continue;
      }
      fs.writeFileSync(file, html);
      console.log(`  ${e.celex} ${e.short}: saved (${Math.round(html.length / 1024)} KB)`);
    } catch (err) {
      console.warn(`  ${e.celex} ${e.short}: ${(err as Error).message}`);
    }
  }
  console.log('Done. Next: npm run build:db');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
