/**
 * Turn free-text Bulgarian (or English) questions into SQLite FTS5 queries.
 *
 * SQLite has no Bulgarian stemmer, so we use a light suffix-stripping "prefix stem"
 * (данъчната → данъчн*, задълженията → задължен*). Stems keep at least 5 letters, so short
 * words are not over-stripped into unrelated ones (платен ↛ плат*, which would match платежна).
 *
 * Each query word becomes a TermGroup: its stem plus a few synonyms that bridge everyday words
 * and legal vocabulary (see synonyms.ts). A group matches if ANY of its variants matches.
 */
import { synonymsFor, type Variant } from './synonyms.js';

const STOPWORDS = new Set([
  // Bulgarian function words
  'и', 'а', 'но', 'или', 'на', 'за', 'в', 'във', 'от', 'с', 'със', 'по', 'при', 'към', 'до', 'след', 'пред',
  'се', 'си', 'да', 'не', 'ли', 'е', 'са', 'съм', 'сме', 'сте', 'бъде', 'бъдат', 'има', 'няма',
  'как', 'какво', 'какви', 'каква', 'какъв', 'кой', 'коя', 'кое', 'кои', 'който', 'която', 'което', 'които',
  'кога', 'къде', 'защо', 'колко', 'дали', 'това', 'този', 'тази', 'тези', 'тоя', 'моя', 'мой', 'моята', 'ми', 'ме',
  'мен', 'мене', 'моите', 'мои', 'аз', 'ти', 'той', 'тя', 'то', 'ние', 'вие', 'те', 'нас', 'вас', 'им', 'го', 'я', 'ги',
  'трябва', 'може', 'могат', 'мога', 'искам', 'нужно', 'необходимо', 'ако', 'че', 'също', 'още', 'вече', 'ще',
  'срещу', 'относно', 'чрез', 'между', 'без', 'през', 'около', 'както', 'когато', 'докато', 'обаче',
  'един', 'една', 'едно', 'някой', 'някоя', 'всеки', 'всяка', 'там', 'тук', 'сега', 'много', 'малко',
  'чл', 'ал', 'т', 'закон', 'закона', 'законът', 'правя', 'прави', 'става', 'има', 'имам', 'имаме',
  // English
  'the', 'a', 'an', 'of', 'to', 'in', 'for', 'and', 'or', 'is', 'are', 'what', 'how', 'when', 'do', 'does', 'i', 'my',
]);

// Longest suffixes first.
const SUFFIXES = [
  'ностите', 'ността', 'ениета', 'ението', 'анията', 'ането', 'ията', 'ието', 'ите', 'ата', 'ото',
  'ски', 'ска', 'ско', 'ова', 'ови', 'ово', 'ват', 'ия', 'ие', 'ът', 'ят', 'ат', 'та', 'то', 'те', 'ен', 'на', 'но', 'ни', 'и', 'а', 'я', 'о', 'е', 'у', 'ю',
];

const MIN_STEM = 5;

export function stem(word: string): string {
  const w = word.toLowerCase();
  if (w.length <= MIN_STEM) return w;
  let out = w;
  for (const s of SUFFIXES) {
    if (out.endsWith(s) && out.length - s.length >= MIN_STEM) {
      out = out.slice(0, -s.length);
      break;
    }
  }
  // Second pass for adjective stems: финансов(ия) → финанс.
  for (const s of ['ов', 'ев']) {
    if (out.endsWith(s) && out.length - s.length >= MIN_STEM) return out.slice(0, -s.length);
  }
  return out;
}

export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[„“”"'«»]/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(t => t.length >= 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

export interface TermGroup {
  token: string;
  variants: Variant[];
}

export function buildTermGroups(query: string, max = 10): TermGroup[] {
  const tokens = [...new Set(tokenize(query))].slice(0, max);
  return tokens.map(token => {
    const variants: Variant[] = [{ term: stem(token), prefix: true }];
    for (const v of synonymsFor(token)) {
      if (!variants.some(x => x.term === v.term)) variants.push(v);
    }
    return { token, variants };
  });
}

const quote = (s: string) => `"${s.replace(/"/g, '')}"`;

function groupFts(g: TermGroup): string {
  const parts = g.variants.map(v => `${quote(v.term)}${v.prefix ? '*' : ''}`);
  return parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
}

/** FTS5 expression requiring every group. */
export function allOf(groups: TermGroup[]): string {
  return groups.map(groupFts).join(' AND ');
}

/** FTS5 expression requiring at least one group. */
export function anyOf(groups: TermGroup[]): string {
  return groups.map(groupFts).join(' OR ');
}

/** All subsets of `groups` of size k (in order), capped to avoid explosion. */
export function combinations<T>(items: T[], k: number, cap = 30): T[][] {
  const out: T[][] = [];
  const rec = (start: number, acc: T[]) => {
    if (out.length >= cap) return;
    if (acc.length === k) { out.push([...acc]); return; }
    for (let i = start; i < items.length; i++) { acc.push(items[i]); rec(i + 1, acc); acc.pop(); }
  };
  rec(0, []);
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const reCache = new Map<string, RegExp>();
function variantRe(v: Variant): RegExp {
  const key = `${v.term}|${v.prefix}`;
  let re = reCache.get(key);
  if (!re) {
    re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(v.term)}${v.prefix ? '' : '(?![\\p{L}\\p{N}])'}`, 'iu');
    reCache.set(key, re);
  }
  return re;
}

/** Does this text contain the group (any variant, word-start match)? */
export function groupIn(g: TermGroup, text: string): boolean {
  return g.variants.some(v => variantRe(v).test(text));
}

export function coverage(groups: TermGroup[], text: string): number {
  if (!groups.length || !text) return 0;
  return groups.filter(g => groupIn(g, text)).length / groups.length;
}

// --- Backwards-compatible helper (used by older callers/tests) ----------------------------------

export interface FtsQueries {
  strict: string | null;
  loose: string | null;
  terms: string[];
}

export function buildFtsQueries(query: string): FtsQueries {
  const groups = buildTermGroups(query, 12);
  if (!groups.length) return { strict: null, loose: null, terms: [] };
  return { strict: allOf(groups), loose: anyOf(groups), terms: groups.map(g => g.token) };
}
