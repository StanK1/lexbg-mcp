/**
 * A provision (Чл. N or § N) as a tree of its units, so amendments can address
 * "чл. 38, ал. 9, т. 2, буква „а“" precisely and renumber units without touching text.
 *
 *   root  Чл. 19.            (body = text after the label when there are no алинеи)
 *   al    (2) ...            алинея
 *   t     1. ...             точка
 *   b     а) ...             буква
 *   bb    аа) ...            подбуква
 *   text  a plain line that follows the numbered units of its алинея / provision
 */

export type NodeKind = 'root' | 'al' | 't' | 'b' | 'bb' | 'text';

export interface Node {
  kind: NodeKind;
  num: string;
  body: string;
  /** Change notes as printed in consolidated texts: "Изм. – ДВ, бр. 72 от 2024 г." */
  marks: string[];
  children: Node[];
  /** Created by the § being applied (so "досегашната т. 3" means the other one). */
  fresh?: boolean;
  repealed?: boolean;
}

export interface ProvisionTree {
  /** 'art' → "Чл. 12.", 'par' → "§ 1." */
  head: 'art' | 'par';
  root: Node;
}

const LOOKALIKE: Record<string, string> = { a: 'а', b: 'б', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у', k: 'к', m: 'м', h: 'н', t: 'т' };

/** Normalise a letter number ("a" typed in Latin, "А" upper case) to lower-case Cyrillic. */
export function normLetter(s: string): string {
  return [...s.toLowerCase()].map(c => LOOKALIKE[c] ?? c).join('');
}

export function normNum(s: string): string {
  return normLetter(s.replace(/\s+/g, ''));
}

const HEAD_RE = /^(Чл\.|§)\s*(\d+[а-яa-z]*)\s*\.\s*/u;
const AL_RE = /^\((\d+[а-яa-z]?)\)\s+(.*)$/u;
const AL_EMPTY_RE = /^\((\d+[а-яa-z]?)\)\s*$/u;
const T_RE = /^(\d+[а-яa-z]?)\.\s+(.*)$/u;
const B_RE = /^([а-яa-z])\)\s+(.*)$/u;
const BB_RE = /^([а-яa-z])\1\)\s+(.*)$/u;
const MARK_RE = /^\(((?:Изм|Нова|Нов|Доп|Отм|Предишн[аи]|Предишен|изм|нова|нов|доп|отм|предишн[аи]|предишен)[^()]*(?:\([^()]*\)[^()]*)*)\)\s*/u;

function node(kind: NodeKind, num: string, body: string): Node {
  return { kind, num, body, marks: [], children: [] };
}

/** Pull "(Изм. – ДВ ...)" notes from the start of a body. */
function takeMarks(n: Node): void {
  let m: RegExpMatchArray | null;
  while ((m = n.body.match(MARK_RE))) {
    n.marks.push(m[1]);
    n.body = n.body.slice(m[0].length);
  }
}

/** Classify one line of provision text. */
export function classifyLine(line: string): Node {
  let m: RegExpMatchArray | null;
  if ((m = line.match(AL_RE))) return withMarks(node('al', normNum(m[1]), m[2]));
  if ((m = line.match(AL_EMPTY_RE))) return node('al', normNum(m[1]), '');
  if ((m = line.match(BB_RE))) return withMarks(node('bb', normLetter(m[1] + m[1]), m[2]));
  if ((m = line.match(B_RE))) return withMarks(node('b', normLetter(m[1]), m[2]));
  if ((m = line.match(T_RE))) return withMarks(node('t', normNum(m[1]), m[2]));
  return node('text', '', line);
}

function withMarks(n: Node): Node {
  takeMarks(n);
  return n;
}

const LEVEL: Record<NodeKind, number> = { root: 0, al: 1, t: 2, b: 3, bb: 4, text: 9 };

/**
 * Build the unit tree from a list of lines whose first line may carry the provision label.
 * Lines are attached to the nearest open unit of a higher level; a plain line closes the
 * open точки/букви and belongs to the enclosing алинея (or the provision).
 */
export function parseUnits(lines: string[], root: Node): Node {
  const stack: Node[] = [root];
  const top = () => stack[stack.length - 1];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const n = classifyLine(line);
    if (n.kind === 'text') {
      // plain text after numbered units: attach to the алинея (or root) that holds them
      while (stack.length > 1 && top().kind !== 'al') stack.pop();
      const parent = top();
      if (!parent.children.length && !parent.body) parent.body = line;
      else parent.children.push(n);
      continue;
    }
    let lvl = LEVEL[n.kind];
    // A "точка" directly under the root when the provision has алинеи cannot exist; keep it
    // under the open алинея. Letters without an open точка go under the алинея / root.
    while (stack.length > 1 && LEVEL[top().kind] >= lvl) stack.pop();
    if (n.kind === 'bb' && top().kind !== 'b') {
      // "аа)" can also be a plain letter in a long list (а … я, аа, бб) – treat as a letter
      n.kind = 'b';
      lvl = LEVEL.b;
      while (stack.length > 1 && LEVEL[top().kind] >= lvl) stack.pop();
    }
    top().children.push(n);
    stack.push(n);
  }
  return root;
}

export function parseProvision(text: string): ProvisionTree {
  const lines = text.split('\n');
  const first = lines[0] ?? '';
  const m = first.match(HEAD_RE);
  const head: 'art' | 'par' = m && m[1] === '§' ? 'par' : 'art';
  const root = node('root', m ? normNum(m[2]) : '', '');
  let rest = m ? first.slice(m[0].length) : first;
  const tmp = node('text', '', rest);
  takeMarks(tmp);
  root.marks = tmp.marks;
  rest = tmp.body;
  const bodyLines: string[] = [];
  if (rest) {
    const c = classifyLine(rest);
    if (c.kind === 'al') bodyLines.push(rest);
    else root.body = rest;
  }
  bodyLines.push(...lines.slice(1));
  parseUnits(bodyLines, root);
  return { head, root };
}

/** Parse a quoted block of new text into units of the given kind ("(3) ...", "1. ..."). */
export function parseFragment(text: string): Node[] {
  const holder = node('root', '', '');
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  // A fragment that starts with a точка must not be glued to the holder's body.
  parseUnits(lines, holder);
  const out = holder.body ? [node('text', '', holder.body), ...holder.children] : holder.children;
  return out;
}

function markText(marks: string[], upper: boolean): string {
  if (!marks.length) return '';
  // "изм. – ДВ, бр. 74 от 2016 г., изм. – ДВ, бр. 98 от 2018 г." → "изм. – ДВ, бр. 74 от 2016 г., бр. 98 от 2018 г."
  const typeOf = (m: string) => m.match(/^([\p{L}]+\.?)\s+–\s+ДВ,\s+/iu)?.[1]?.toLowerCase();
  const joined = marks.map((m, i) => {
    const t = typeOf(m);
    if (i > 0 && t && t === typeOf(marks[i - 1])) return m.replace(/^[\p{L}]+\.?\s+–\s+ДВ,\s+/u, '');
    return i === 0 ? m : m.charAt(0).toLowerCase() + m.slice(1);
  }).join(', ');
  const s = upper ? joined.charAt(0).toUpperCase() + joined.slice(1) : joined.charAt(0).toLowerCase() + joined.slice(1);
  return `(${s}) `;
}

function lineOf(n: Node): string {
  const marks = markText(n.marks, n.kind === 'al' || n.kind === 'root');
  const body = n.body;
  switch (n.kind) {
    case 'al': return `(${n.num}) ${marks}${body}`.trimEnd();
    case 't': return `${n.num}. ${marks}${body}`.trimEnd();
    case 'b':
    case 'bb': return `${n.num}) ${marks}${body}`.trimEnd();
    case 'text': return body;
    default: return body;
  }
}

function emit(n: Node, out: string[]): void {
  for (const c of n.children) {
    out.push(lineOf(c));
    emit(c, out);
  }
}

export function serialize(t: ProvisionTree): string {
  const r = t.root;
  const label = t.head === 'par' ? `§ ${r.num}.` : `Чл. ${r.num}.`;
  const marks = markText(r.marks, true);
  const out: string[] = [];
  const children = [...r.children];
  let first = `${label} ${marks}${r.body}`.trimEnd();
  if (!r.body && children.length && children[0].kind === 'al') {
    const c = children.shift()!;
    first = `${first} ${lineOf(c)}`;
    out.push(first);
    emit(c, out);
  } else {
    out.push(first);
  }
  for (const c of children) {
    out.push(lineOf(c));
    emit(c, out);
  }
  return out.join('\n');
}

export function cloneNode(n: Node): Node {
  return { ...n, marks: [...n.marks], children: n.children.map(cloneNode) };
}

/** Compare unit numbers: "5" < "5а" < "6"; letters by alphabet. */
export function compareNums(a: string, b: string): number {
  const pa = a.match(/^(\d*)(.*)$/)!;
  const pb = b.match(/^(\d*)(.*)$/)!;
  const na = pa[1] ? Number(pa[1]) : NaN;
  const nb = pb[1] ? Number(pb[1]) : NaN;
  if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
  return pa[2].localeCompare(pb[2], 'bg');
}

/** Every node of the subtree (including n). */
export function walk(n: Node, out: Node[] = []): Node[] {
  out.push(n);
  for (const c of n.children) walk(c, out);
  return out;
}

// ------------------------------------------------------------------ loose text matching

const DASH = '[-–—‑]';
const QUOTE = '[„“"”«»]';

function charClass(c: string): string {
  if (/\s/.test(c)) return '\\s+';
  if (/[-–—‑]/.test(c)) return `\\s*${DASH}\\s*`;
  if (/[„“"”«»]/.test(c)) return QUOTE;
  const lower = c.toLowerCase();
  const cyr = LOOKALIKE[lower];
  const lat = Object.entries(LOOKALIKE).find(([, v]) => v === lower)?.[0];
  if (cyr || lat) {
    const set = new Set([c, lower, c.toUpperCase(), cyr ?? lower, lat ?? lower, (cyr ?? lower).toUpperCase(), (lat ?? lower).toUpperCase()]);
    return `[${[...set].map(x => x.replace(/[\]\\^-]/g, '\\$&')).join('')}]`;
  }
  return c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Regex for a quoted phrase from an amending act, tolerant to whitespace, dash, quote and
 * Latin/Cyrillic look-alike differences. Word boundaries are enforced for letters.
 */
export function looseRegex(needle: string, flags = 'gu'): RegExp {
  const n = needle.trim().replace(/\s+/g, ' ').replace(/\s*[-–—‑]\s*/gu, '–');
  let src = '';
  let prevSpace = false;
  for (const c of n) {
    if (c === ' ') {
      if (!prevSpace) src += '\\s+';
      prevSpace = true;
      continue;
    }
    prevSpace = false;
    src += charClass(c);
  }
  const startsWord = /^[\p{L}\p{N}]/u.test(n);
  const endsWord = /[\p{L}\p{N}]$/u.test(n);
  return new RegExp(`${startsWord ? '(?<![\\p{L}\\p{N}])' : ''}${src}${endsWord ? '(?![\\p{L}\\p{N}])' : ''}`, flags);
}

export function countLoose(hay: string, needle: string): number {
  return [...hay.matchAll(looseRegex(needle))].length;
}
