#!/usr/bin/env tsx
/**
 * OPTIONAL AI layer: extract structured obligations ("who must do what, by when") from one law
 * with an LLM, keeping ONLY items whose quote appears verbatim in the provision.
 *
 *   ANTHROPIC_API_KEY=... npm run extract:obligations -- --law zsch
 *   npm run extract:obligations -- --law zsch --limit 5      # try on 5 provisions first
 *   npm run extract:obligations -- --law zsch --dry-run      # print the prompt, no API call
 *
 * Output: data/obligations/<law>.json (review it, set review_status to "approved"/"rejected"),
 * then `npm run build:db` loads it and the get_obligations tool serves it.
 * Environment: ANTHROPIC_API_KEY (required), LEXBG_MODEL (default claude-sonnet-5-5).
 */
import '../src/quiet.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { defaultDbPath, openDb } from '../src/db.js';
import { canonical } from '../src/text/html.js';
import { ROOT, argValue, hasFlag } from './lib/paths.js';
import { sleep } from './lib/http.js';

interface Item { provision: string; subject: string; action: string; deadline?: string | null; quote: string; review_status: string }
interface OutFile { law_id: string; model: string; extracted_at: string; text_status: string; processed: string[]; rejected_quotes: number; items: Item[] }

const MODEL = process.env.LEXBG_MODEL ?? 'claude-sonnet-5-5';

const SYSTEM = `You extract legal obligations from Bulgarian statutory text.
Return ONLY JSON: {"obligations":[{"subject":"...","action":"...","deadline":"..."|null,"quote":"..."}]}.
Rules:
- An obligation is something a person or entity MUST or MUST NOT do ("длъжни са", "задължени са", "трябва", "се подава", "не може", "е длъжен", "съставят", "публикуват", "съхраняват" used normatively).
- "subject": who is obliged, in Bulgarian, as written or briefly (e.g. "предприятията", "ръководителят на предприятието").
- "action": what they must do, a short Bulgarian paraphrase (max 25 words).
- "deadline": the time limit exactly as written in the text, or null.
- "quote": the shortest EXACT, contiguous substring of the provision that states the obligation. Copy it character for character. Never paraphrase the quote.
- Do not include definitions, powers of authorities to issue acts, or penalties.
- If there is no obligation, return {"obligations":[]}.`;

async function ask(provisionLabel: string, text: string): Promise<Array<Omit<Item, 'provision' | 'review_status'>>> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Set ANTHROPIC_API_KEY (or use --dry-run).');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM,
      messages: [{ role: 'user', content: `Provision: ${provisionLabel}\n\n${text}` }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json() as { content: Array<{ type: string; text?: string }> };
  const out = body.content.filter(c => c.type === 'text').map(c => c.text).join('');
  const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
  const parsed = JSON.parse(json) as { obligations?: Array<{ subject: string; action: string; deadline?: string | null; quote: string }> };
  return parsed.obligations ?? [];
}

async function main(): Promise<void> {
  const lawId = argValue('--law');
  if (!lawId) throw new Error('Pass --law <id>, e.g. --law zsch');
  const limit = argValue('--limit') ? Number(argValue('--limit')) : Infinity;
  const dry = hasFlag('--dry-run');

  const db = openDb(defaultDbPath(), { readOnly: true });
  const law = db.prepare('SELECT id, short, text_status FROM laws WHERE id = ?').get(lawId) as { id: string; short: string; text_status: string } | undefined;
  if (!law) throw new Error(`Unknown law id "${lawId}" (see npm run coverage).`);
  if (law.text_status === 'missing') throw new Error(`${law.short} has no text in the database yet.`);
  const provisions = db.prepare(`SELECT label, text FROM provisions WHERE law_id = ? AND kind IN ('art', 'par') AND length(text) > 120 ORDER BY ord`)
    .all(lawId) as Array<{ label: string; text: string }>;

  const dir = path.join(ROOT, 'data', 'obligations');
  const file = path.join(dir, `${lawId}.json`);
  fs.mkdirSync(dir, { recursive: true });
  const out: OutFile = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : { law_id: lawId, model: MODEL, extracted_at: new Date().toISOString(), text_status: law.text_status, processed: [], rejected_quotes: 0, items: [] };

  const todo = provisions.filter(p => !out.processed.includes(p.label)).slice(0, limit);
  console.log(`${law.short}: ${todo.length} provisions to process with ${MODEL}${dry ? ' (dry run)' : ''}.`);

  for (const p of todo) {
    if (dry) {
      console.log(`--- ${p.label}\n${SYSTEM}\n\nProvision: ${p.label}\n\n${p.text.slice(0, 400)}…`);
      break;
    }
    try {
      const found = await ask(p.label, p.text);
      const source = canonical(p.text);
      let kept = 0;
      for (const o of found) {
        if (!o.quote || !source.includes(canonical(o.quote))) {
          out.rejected_quotes += 1;
          continue;
        }
        out.items.push({ provision: p.label, subject: o.subject, action: o.action, deadline: o.deadline ?? null, quote: o.quote, review_status: 'unreviewed' });
        kept += 1;
      }
      out.processed.push(p.label);
      fs.writeFileSync(file, JSON.stringify(out, null, 2));
      console.log(`  ${p.label}: ${kept} obligation(s)${found.length > kept ? `, ${found.length - kept} rejected (quote not verbatim)` : ''}`);
    } catch (err) {
      console.warn(`  ${p.label}: ${(err as Error).message}`);
    }
    await sleep(300);
  }
  if (!dry) {
    console.log(`\nSaved ${out.items.length} obligations (${out.rejected_quotes} rejected quotes so far) → ${path.relative(process.cwd(), file)}`);
    console.log('Review the file, set review_status to "approved" or "rejected", then run: npm run build:db');
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
