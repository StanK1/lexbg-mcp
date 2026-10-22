#!/usr/bin/env tsx
/**
 * Import consolidated texts published by public institutions (Министерство на финансите, НАП,
 * МТСП, НОИ, КЗЛД, …) into data/manual/, for laws whose original act predates the parliament.bg
 * catalogue. The build then applies every amending act published AFTER the last State Gazette
 * issue listed in the text's header, so the snapshot does not need to be recent.
 *
 *   npm run fetch:agency                              # every entry in sources/agency-texts.yml
 *   npm run fetch:agency -- --law zdds                # one entry
 *   npm run fetch:agency -- --law kt --file ~/Downloads/KT.pdf --source-url https://… --institution "МТСП"
 *                                                     # a file you downloaded yourself
 *
 * Supported formats: PDF, HTML, TXT. Only use texts published by public institutions — not the
 * databases of commercial publishers (see DATA_SOURCES.md).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { htmlToLines, textToLines } from '../src/text/html.js';
import { bodyFrom, headerIssues, latestIssue, reflowLines } from '../src/text/consolidated.js';
import { parseBulgarianAct } from '../src/text/parse-bg.js';
import { loadRegistry } from '../src/registry.js';
import { ROOT, argValue, paths, rawDir } from './lib/paths.js';

interface Entry {
  law: string;
  url: string;
  institution: string;
  format?: 'pdf' | 'html' | 'txt';
  note?: string;
}

function detectFormat(file: string, declared?: string): 'pdf' | 'html' | 'txt' {
  if (declared === 'pdf' || declared === 'html' || declared === 'txt') return declared;
  const head = fs.readFileSync(file).subarray(0, 512).toString('latin1');
  if (head.startsWith('%PDF')) return 'pdf';
  if (/<html|<!doctype|<body|<div/i.test(head)) return 'html';
  return 'txt';
}

async function pdfToText(file: string): Promise<string> {
  // pdf.js keeps line breaks and hyphens as printed (pdftotext silently joins "най-" + "малко" into "наймалко")
  try {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync(file)));
    const { text } = await extractText(pdf, { mergePages: false });
    return (Array.isArray(text) ? text : [text]).join('\n');
  } catch {
    return execFileSync('pdftotext', ['-enc', 'UTF-8', file, '-'], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8');
  }
}

async function download(url: string, to: string): Promise<void> {
  const res = await fetch(url, { headers: { 'User-Agent': 'LexBG (+https://github.com/StanK1/lexbg-mcp)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  fs.writeFileSync(to, Buffer.from(await res.arrayBuffer()));
}

export interface Imported {
  law: string;
  lines: string[];
  provisions: number;
  issues: string[];
  through: string | null;
}

/** Convert a downloaded file into clean provision lines and read its header. */
export async function convert(file: string, format?: string): Promise<{ lines: string[]; issues: string[] }> {
  const fmt = detectFormat(file, format);
  let lines: string[];
  if (fmt === 'pdf') lines = reflowLines((await pdfToText(file)).split('\n'));
  else if (fmt === 'html') lines = htmlToLines(fs.readFileSync(file, 'utf8'));
  else lines = reflowLines(textToLines(fs.readFileSync(file, 'utf8')));
  const issues = headerIssues(lines.join('\n'));
  return { lines: bodyFrom(lines), issues };
}

async function importOne(e: Entry, localFile?: string): Promise<Imported> {
  const dir = path.join(rawDir(), 'agency');
  fs.mkdirSync(dir, { recursive: true });
  let file = localFile ? path.resolve(localFile.replace(/^~(?=\/)/, process.env.HOME ?? '~')) : path.join(dir, `${e.law}.download`);
  if (!localFile) await download(e.url, file);
  else if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  const { lines, issues } = await convert(file, e.format);
  const provisions = parseBulgarianAct(lines).filter(p => p.kind === 'art').length;
  if (provisions < 3) throw new Error(`${e.law}: only ${provisions} article(s) recognised — is this the law text?`);
  const through = latestIssue(issues);
  fs.mkdirSync(paths.manual, { recursive: true });
  fs.writeFileSync(path.join(paths.manual, `${e.law}.txt`), `${lines.join('\n')}\n`);
  const meta: Record<string, unknown> = {
    source_url: e.url,
    institution: e.institution,
    retrieved_at: new Date().toISOString().slice(0, 10),
    // last State Gazette issue included in this consolidated text (from its header)
    through_gazette: through ? `ДВ, бр. ${through.split('/')[0]} от ${through.split('/')[1]} г.` : null,
    note: e.note ?? `Consolidated text published by ${e.institution}.`,
  };
  fs.writeFileSync(path.join(paths.manual, `${e.law}.yml`), YAML.stringify(meta));
  if (file.endsWith('.download')) fs.renameSync(file, file.replace(/\.download$/, detectFormat(file, e.format) === 'pdf' ? '.pdf' : '.html'));
  return { law: e.law, lines, provisions, issues, through };
}

async function main(): Promise<void> {
  const reg = loadRegistry();
  const only = argValue('--law');
  const localFile = argValue('--file');
  const listFile = path.join(ROOT, 'sources', 'agency-texts.yml');
  const entries = (fs.existsSync(listFile) ? (YAML.parse(fs.readFileSync(listFile, 'utf8')) as { texts?: Entry[] }).texts ?? [] : []);
  let todo = only ? entries.filter(e => e.law === only) : entries;
  if (localFile) {
    if (!only) throw new Error('--file needs --law <id>');
    const url = argValue('--source-url') ?? todo[0]?.url;
    const institution = argValue('--institution') ?? todo[0]?.institution;
    if (!url || !institution) throw new Error('--file needs --source-url and --institution (where the file was published)');
    todo = [{ law: only, url, institution }];
  }
  if (!todo.length && !only) { console.log('sources/agency-texts.yml has no entries — nothing to fetch.'); return; }
  if (!todo.length) throw new Error(only ? `No entry for "${only}" in sources/agency-texts.yml (or pass --file).` : 'sources/agency-texts.yml has no entries.');
  for (const e of todo) {
    if (!reg.laws.some(l => l.id === e.law)) { console.warn(`  ${e.law}: unknown law id — skipped`); continue; }
    try {
      const r = await importOne(e, localFile);
      console.log(`  ${e.law}: ${r.provisions} articles; header lists ${r.issues.length} State Gazette issue(s), latest ${r.through ?? 'unknown'} → data/manual/${e.law}.txt`);
      if (!r.through) console.warn(`  ${e.law}: no "Обн. ДВ … изм. …" header found — set through_gazette in data/manual/${e.law}.yml by hand, or later amendments cannot be applied.`);
    } catch (err) {
      console.error(`  ${e.law}: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  }
  console.log('Next: npm run build:db');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(err => { console.error(err); process.exit(1); });
