/**
 * Loads the YAML registries in ./sources and resolves user input to a law, EU act or topic.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export interface LawEntry {
  id: string;
  short: string;
  title: string;
  base_titles?: string[];
  genitive: string;
  genitives?: string[];
  aliases?: string[];
  topics: string[];
}

export interface EuEntry {
  celex: string;
  short: string;
  title: string;
  aliases?: string[];
  topics: string[];
}

export type Condition = Partial<{
  always: boolean;
  entity_type: string[];
  has_employees: boolean;
  processes_personal_data: boolean;
  sells_to_consumers: boolean;
  sells_online: boolean;
  vat_status: string[];
  aml_obliged: string[];
  sector: string[];
}>;

export interface TopicEntry {
  id: string;
  title: string;
  title_en: string;
  summary: string;
  laws: string[];
  eu: string[];
  queries: string[];
  questions: string[];
  applies_if: Condition[];
}

export interface Registry {
  root: string;
  laws: LawEntry[];
  eu: EuEntry[];
  topics: TopicEntry[];
}

/** Walk up from this file until we find the repository root (the folder with sources/laws.yml). */
export function findRoot(start = path.dirname(fileURLToPath(import.meta.url))): string {
  if (process.env.LEXBG_ROOT) return path.resolve(process.env.LEXBG_ROOT);
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'sources', 'laws.yml'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('LexBG: could not find sources/laws.yml. Set LEXBG_ROOT to the repository folder.');
}

let cached: Registry | null = null;

/** Registry stored inside a database by build-db (meta key "registry"), so a downloaded DB is self-contained. */
export function registryFromJson(json: string, root = '(database)'): Registry {
  const doc = JSON.parse(json) as Omit<Registry, 'root'>;
  const reg: Registry = { root, laws: doc.laws ?? [], eu: doc.eu ?? [], topics: doc.topics ?? [] };
  validate(reg);
  return reg;
}

export function registryToJson(reg: Registry): string {
  return JSON.stringify({ laws: reg.laws, eu: reg.eu, topics: reg.topics });
}

export function loadRegistry(root = findRoot()): Registry {
  if (cached && cached.root === root) return cached;
  const read = <T>(file: string, key: string): T[] => {
    const doc = YAML.parse(fs.readFileSync(path.join(root, 'sources', file), 'utf8')) as Record<string, T[]>;
    return doc[key] ?? [];
  };
  const reg: Registry = {
    root,
    laws: read<LawEntry>('laws.yml', 'laws'),
    eu: read<EuEntry>('eu.yml', 'eu_acts'),
    topics: read<TopicEntry>('topics.yml', 'topics'),
  };
  validate(reg);
  cached = reg;
  return reg;
}

function validate(reg: Registry): void {
  const lawIds = new Set(reg.laws.map(l => l.id));
  const celex = new Set(reg.eu.map(e => e.celex));
  const topicIds = new Set(reg.topics.map(t => t.id));
  const problems: string[] = [];
  for (const l of reg.laws) {
    for (const t of l.topics) if (!topicIds.has(t)) problems.push(`law ${l.id}: unknown topic ${t}`);
  }
  for (const e of reg.eu) {
    if (!/^3\d{4}[RL]\d{4}$/.test(e.celex)) problems.push(`eu ${e.celex}: invalid CELEX`);
    for (const t of e.topics) if (!topicIds.has(t)) problems.push(`eu ${e.celex}: unknown topic ${t}`);
  }
  for (const t of reg.topics) {
    for (const id of t.laws) if (!lawIds.has(id)) problems.push(`topic ${t.id}: unknown law ${id}`);
    for (const c of t.eu) if (!celex.has(c)) problems.push(`topic ${t.id}: unknown EU act ${c}`);
  }
  if (problems.length) throw new Error(`LexBG registry is inconsistent:\n- ${problems.join('\n- ')}`);
}

const norm = (s: string) => s.toLowerCase().replace(/[„“"«»]/g, '').replace(/\s+/g, ' ').trim();

/** Resolve "ЗДДС", "zdds", "VAT act", "Закона за данък върху добавената стойност" → law entry. */
export function resolveLaw(reg: Registry, input: string): LawEntry | null {
  const q = norm(input);
  if (!q) return null;
  for (const l of reg.laws) {
    const names = [l.id, l.short, l.title, l.genitive, ...(l.base_titles ?? []), ...(l.genitives ?? []), ...(l.aliases ?? [])];
    if (names.some(n => norm(n) === q)) return l;
  }
  // Fallback: the input contains a full title/genitive, or a short name as a separate token.
  for (const l of reg.laws) {
    const longNames = [l.title, l.genitive, ...(l.base_titles ?? []), ...(l.genitives ?? [])];
    if (longNames.some(n => q.includes(norm(n)))) return l;
  }
  for (const l of reg.laws) {
    const re = new RegExp(`(?<!\\p{L})${escapeRe(norm(l.short))}(?!\\p{L})`, 'u');
    if (re.test(q)) return l;
  }
  return null;
}

export function resolveEu(reg: Registry, input: string): EuEntry | null {
  const q = norm(input);
  for (const e of reg.eu) {
    const names = [e.celex, e.short, e.title, ...(e.aliases ?? [])];
    if (names.some(n => norm(n) === q)) return e;
  }
  for (const e of reg.eu) {
    if ((e.aliases ?? []).some(a => q.includes(norm(a)) && a.length >= 4)) return e;
  }
  return null;
}

export function resolveTopic(reg: Registry, input: string): TopicEntry | null {
  const q = norm(input);
  return reg.topics.find(t => t.id === q || norm(t.title) === q || norm(t.title_en) === q) ?? null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
