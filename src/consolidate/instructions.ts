/**
 * Parse the amending instructions of a § in an amending act into structured operations.
 *
 *   § 4. В чл. 19 се правят следните изменения:
 *   1. В ал. 2 т. 1 и 2 се изменят така:
 *   „1. балансова стойност на активите – 900 000 лв.;
 *   2. нетни приходи от продажби – 1 800 000 лв.;“.
 *
 * becomes  { scope: чл. 19 › ал. 2 › т. 1, 2 ; action: replace with the quoted units }.
 *
 * Bulgarian amending acts follow a fixed drafting style (Указ за прилагане на ЗНА, чл. 30–34),
 * so a small grammar covers most instructions. Anything not understood becomes an
 * `unknown` operation, which the applier reports instead of guessing.
 */
import { normLetter, normNum } from './tree.js';

export type PartRef = 'main' | 'dr' | 'pzr' | 'pr' | 'zr';
export type AddrKind = 'art' | 'par' | 'al' | 't' | 'b' | 'bb' | 'sent' | 'intro';

export interface Addr {
  kind: AddrKind;
  nums: string[];
}

export interface Scope {
  part?: PartRef;
  /** The instruction amends another act (e.g. the transitional provisions of an earlier amending act). */
  otherAct?: string;
  path: Addr[];
  everywhere?: boolean;
  /** "Навсякъде в закона …" / "В останалите текстове на закона …" */
  lawWide?: boolean;
  /** Heading context: "глава пета", "раздел III" */
  glava?: string;
  razdel?: string;
  /** "наименованието на ..." (a heading) or "заглавието" (an article title) is the target */
  headingTarget?: 'glava' | 'razdel' | 'title' | 'annex';
}

export type WordOp =
  | { op: 'replace'; from: string; to: string; commaBefore?: boolean }
  | { op: 'delete'; text: string; commaBefore?: boolean; commaAfter?: boolean }
  | { op: 'insertAfter'; anchor: string; text: string; commaBefore?: boolean; commaAfter?: boolean; sep?: string }
  | { op: 'replaceAfter'; anchor: string; from: string; to: string }
  | { op: 'prepend'; text: string }
  | { op: 'appendLine'; text: string }
  | { op: 'punctAfter'; anchor: string; punct: string }
  | { op: 'insertBefore'; anchor: string; text: string }
  | { op: 'append'; text: string; comma?: boolean }
  | { op: 'truncateAfter'; anchor: string };

export type Action =
  | { type: 'replace'; quotes: string[] }
  | { type: 'repeal' }
  | { type: 'create'; what: Addr; isNew: boolean; quotes: string[]; razdel?: string }
  | { type: 'renumber'; from: Addr; to: Addr; then?: Action; thenPath?: Addr[] }
  | { type: 'wrap'; into: Addr }
  | { type: 'words'; ops: WordOp[] }
  | { type: 'noop'; why: string }
  | { type: 'unknown'; why: string };

export interface Op {
  scope: Scope;
  action: Action;
  /** Number of the top-level item of the § ("§ 6, т. 1"), for entry-into-force rules. */
  item?: string;
  /** The instruction as written (quotes restored), for logs. */
  source: string;
}

// ------------------------------------------------------------------ quotes

export interface Quoted {
  text: string;
  quotes: string[];
}

/** Replace every top-level „…“ with ⟦qN⟧ so the grammar can ignore quoted content. */
export function extractQuotes(s: string, quotes: string[] = []): Quoted {
  let out = '';
  let depth = 0;
  let buf = '';
  let short = false;
  const chars = [...s];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === '„') {
      if (depth === 0) {
        buf = '';
        // a short phrase ("думите „…“ се заменят") vs a block of new text ("се изменя така: „…“")
        short = !/:\s*$/u.test(out);
      } else buf += c;
      depth++;
      continue;
    }
    if (c === '“' && depth > 0) {
      depth--;
      // Bulgarian typography often closes a nested quote and the outer one with a single “:
      // думите „Служба „Военна информация“ се заменят …  — close both when the instruction resumes.
      if (depth > 0 && short && !buf.includes('\n')) {
        const ahead = chars.slice(i + 1, i + 24).join('');
        if (/^(?:\s+(?:се|и|а|с|със)\s|,\s|;|\.(?:\s|$)|\s*$)/u.test(ahead)) {
          buf += c;
          depth = 0;
        }
      }
      if (depth === 0) {
        out += `⟦q${quotes.length}⟧`;
        quotes.push(buf);
      } else buf += c;
      continue;
    }
    if (depth > 0) buf += c;
    else out += c;
  }
  if (depth > 0) out += `„${buf}`; // unbalanced: keep as text
  return { text: out, quotes };
}

export function restoreQuotes(s: string, quotes: string[]): string {
  return s.replace(/⟦q(\d+)⟧/g, (_, i) => `„${quotes[Number(i)]}“`);
}

// ------------------------------------------------------------------ items

interface Item {
  level: number;
  num?: string;
  text: string;
  children: Item[];
}

/**
 * Split a § into its numbered items (1., а), аа)), ignoring numbers inside quoted text.
 * Returns the header (text before the first item) and the item tree.
 */
export function splitItems(sectionText: string): Item {
  const root: Item = { level: 0, text: '', children: [] };
  const stack: Item[] = [root];
  let depth = 0;
  for (const line of sectionText.split('\n')) {
    let level = 0;
    if (depth === 0) {
      if (/^\d+[а-я]?\.\s+\S/u.test(line)) level = 1;
      else if (/^([а-яa-z])\1\)\s+\S/u.test(line)) level = 3;
      else if (/^[а-яa-z]\)\s+\S/u.test(line)) level = 2;
    }
    if (level > 0) {
      while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
      const it: Item = { level, num: line.match(/^(\d+[а-я]?|[а-яa-z]{1,2})[.)]/u)?.[1], text: line.replace(/^(?:\d+[а-я]?\.|[а-яa-z]{1,2}\))\s+/u, ''), children: [] };
      stack[stack.length - 1].children.push(it);
      stack.push(it);
    } else {
      const cur = stack[stack.length - 1];
      cur.text = cur.text ? `${cur.text}\n${line}` : line;
    }
    for (const c of line) {
      if (c === '„') depth++;
      else if (c === '“' && depth > 0) depth--;
    }
  }
  return root;
}

// ------------------------------------------------------------------ scope grammar

const ORDINALS: Record<string, string> = {
  първо: '1', първа: '1', първи: '1', второ: '2', втора: '2', втори: '2', трето: '3', трета: '3', трети: '3',
  четвърто: '4', четвърта: '4', пето: '5', пета: '5', шесто: '6', шеста: '6', седмо: '7', седма: '7',
  осмо: '8', осма: '8', девето: '9', девета: '9', десето: '10', десета: '10',
};

/** "1, 2, 3 и 6" → ['1','2','3','6'];  "35 – 41" → 35…41;  "62а – чл. 62г" → 62а…62г */
export function expandNums(list: string): string[] {
  const parts = list.split(/\s*(?:,|\sи\s)\s*/u).map(s => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    const r = p.match(/^(\d+)([а-я]?)\s*[–-]\s*(?:(?:чл\.|ал\.|т\.|§)\s*)?(\d+)([а-я]?)$/u);
    if (r) {
      const [a, as, b, bs] = [Number(r[1]), r[2], Number(r[3]), r[4]];
      if (a === b && as && bs) {
        const letters = 'абвгдежзийклмнопрстуфхцчшщъьюя';
        const i0 = letters.indexOf(as);
        const i1 = letters.indexOf(bs);
        for (let i = i0; i <= i1 && i0 >= 0; i++) out.push(`${a}${letters[i]}`);
      } else if (!as && !bs && b >= a && b - a < 200) {
        for (let i = a; i <= b; i++) out.push(String(i));
      } else out.push(normNum(r[1] + r[2]), normNum(r[3] + r[4]));
    } else out.push(normNum(p));
  }
  return out;
}

const NUM = String.raw`\d+[а-яa-z]?`;
const NUMLIST = String.raw`${NUM}(?:\s*(?:,|и)\s*${NUM}|\s*[–-]\s*(?:(?:чл\.|ал\.|т\.|§)\s*)?${NUM})*`;
const Q = String.raw`⟦q\d+⟧`;
const QLIST = String.raw`${Q}(?:\s*(?:,|и)\s*${Q})*`;
const ORD = Object.keys(ORDINALS).join('|');

interface AddrPattern { re: RegExp; kind: AddrKind; quoted?: boolean; ordinal?: boolean }

const ADDR_PATTERNS: AddrPattern[] = [
  { kind: 'art', re: new RegExp(String.raw`^(?:чл\.|член|членове|членовете)\s*(${NUMLIST})`, 'iu') },
  { kind: 'al', re: new RegExp(String.raw`^(?:ал\.|алинея|алинеи|алинеите)\s*(${NUMLIST})`, 'iu') },
  { kind: 't', re: new RegExp(String.raw`^(?:т\.|точка|точки|точките)\s*(${NUMLIST})`, 'iu') },
  { kind: 'b', re: new RegExp(String.raw`^(?:буква|букви|буквите|б\.)\s*(${QLIST})`, 'iu'), quoted: true },
  { kind: 'par', re: new RegExp(String.raw`^(?:§|параграф|параграфи)\s*(${NUMLIST})`, 'iu') },
  { kind: 'sent', re: new RegExp(String.raw`^(?:изречение|изречения)\s+((?:${ORD})(?:\s*(?:,|и)\s*(?:${ORD}))*)`, 'iu'), ordinal: true },
];

const PART_PHRASES: Array<[RegExp, PartRef]> = [
  [/^(?:от|на|в)\s+допълнителн(?:ите|ата)\s+разпоредб(?:и|а)/iu, 'dr'],
  [/^(?:от|на|в)\s+преходн(?:ите|ата)\s+и\s+заключителн(?:ите|ата)\s+разпоредб(?:и|а)/iu, 'pzr'],
  [/^(?:от|на|в)\s+преходн(?:ите|ата)\s+разпоредб(?:и|а)/iu, 'pr'],
  [/^(?:от|на|в)\s+заключителн(?:ите|ата)\s+разпоредб(?:и|а)/iu, 'zr'],
];

const GLAVA_RE = /^(?:(?:в|на)\s+)?(?:наименованието\s+на\s+)?глава\s+((?:[\p{L}]+\s+и\s+)?[\p{L}]+(?:\s+⟦q\d+⟧)?|[IVXLCІХ]+|\d+)/iu;
const RAZDEL_RE = /^(?:(?:в|на)\s+)?(?:наименованието\s+на\s+)?(?:раздел)\s+([IVXLCІХ]+[а-яa-z]?|\d+[а-я]?|⟦q\d+⟧)/iu;

export interface ScopeParse {
  scope: Scope;
  rest: string;
}

/** Consume address phrases at the start of an instruction. */
export function parseScope(text: string, quotes: string[], base: Scope): ScopeParse {
  let s = text.trim();
  const scope: Scope = { ...base, path: [...base.path] };
  const local: Addr[] = [];
  for (let guard = 0; guard < 40 && s; guard++) {
    s = s.replace(/^,\s*/u, '').trim();
    // the phrase may be introduced by "в"/"във" ("в чл. 5", "в т. 2") or stand alone ("точка 4 се отменя")
    const bare = s.replace(/^(?:в|във)\s+/iu, '');
    let m: RegExpMatchArray | null;
    // "След чл. 267 се създава …": the position follows from the new number itself
    if ((m = s.match(/^след\s+(?=(?:чл\.|§|ал\.|т\.)\s*\d)/iu))) {
      s = s.slice(m[0].length);
      const p = ADDR_PATTERNS.find(x => x.re.test(s));
      const mm = p ? s.match(p.re) : null;
      if (mm) s = s.slice(mm[0].length);
      continue;
    }
    // "Алинея 6 и ал. 10, 11 и 13 се отменят": more units of the same kind
    if (local.length && (m = s.match(/^и\s+/u))) {
      const restS = s.slice(m[0].length);
      const p = ADDR_PATTERNS.find(x => x.kind === local[local.length - 1].kind && !x.quoted && !x.ordinal && x.re.test(restS));
      const mm = p ? restS.match(p.re) : null;
      if (mm) {
        local[local.length - 1].nums.push(...expandNums(mm[1]));
        s = restS.slice(mm[0].length);
        continue;
      }
    }
    // headings of parts and titles ("в част трета в наименованието на дял втори") — not provision text
    if ((m = bare.match(/^(?:наименованието\s+на\s+)?(?:част|дял)\s+[\p{L}IVX]+\s*/iu)) && !/^(?:част|дял)\s+\S+\s+се\s/iu.test(bare)) {
      scope.headingTarget = scope.headingTarget ?? 'title';
      s = bare.slice(m[0].length);
      continue;
    }
    if ((m = s.match(/^(?:навсякъде\s+в\s+(?:закона|кодекса)|в\s+останалите\s+текстове\s+на\s+(?:закона|кодекса))\s*/iu))) {
      scope.lawWide = true;
      scope.everywhere = true;
      s = s.slice(m[0].length);
      continue;
    }
    // annexes are not part of the provision texts
    if ((m = bare.match(/^приложени(?:ето|е)(?:\s+№\s*\d+)?(?:\s+към\s+(?:закона|чл\.\s*\d+[а-я]?))?\s*/iu))) {
      scope.headingTarget = 'annex';
      s = bare.slice(m[0].length);
      continue;
    }
    // "В Закона за изменение и допълнение на Закона за … в § 82 от преходните …" — another act
    if ((m = s.match(/^в\s+((?:Закона|Кодекса)\s+за\s+изменение.+?)(?=\s+(?:в|във)\s+(?:§|преходните|заключителните)|\s+се\s)/iu))) {
      scope.otherAct = m[1];
      s = s.slice(m[0].length);
      continue;
    }
    if ((m = bare.match(/^навсякъде(?![\p{L}])\s*/iu))) {
      scope.everywhere = true;
      s = bare.slice(m[0].length);
      continue;
    }
    if ((m = bare.match(/^текст(?:а|ът)\s+преди\s+(?:т\.\s*\d+[а-я]?|буква\s+⟦q\d+⟧|ал\.\s*\d+)\s*/iu))) {
      local.push({ kind: 'intro', nums: [] });
      s = bare.slice(m[0].length);
      continue;
    }
    if ((m = bare.match(/^(наименованието|заглавието)\s+(?:на\s+)?/iu))) {
      s = bare.slice(m[0].length);
      if (m[1].toLowerCase() === 'заглавието') { scope.headingTarget = 'title'; continue; }
      const g = s.match(GLAVA_RE);
      const r = s.match(RAZDEL_RE);
      if (g) { scope.glava = g[1].toLowerCase(); scope.headingTarget = 'glava'; s = s.slice(g[0].length); }
      else if (r) { scope.razdel = normNum(r[1]).toUpperCase(); scope.headingTarget = 'razdel'; s = s.slice(r[0].length); }
      else scope.headingTarget = 'title';
      continue;
    }
    if ((m = bare.match(GLAVA_RE))) {
      scope.glava = m[1].toLowerCase();
      s = bare.slice(m[0].length);
      continue;
    }
    if ((m = bare.match(RAZDEL_RE))) {
      scope.razdel = m[1].toUpperCase().replace(/І/gu, 'I').replace(/Х/gu, 'X');
      s = bare.slice(m[0].length);
      continue;
    }
    let matched = false;
    for (const p of ADDR_PATTERNS) {
      m = bare.match(p.re);
      if (!m) continue;
      let nums: string[];
      if (p.quoted) nums = [...m[1].matchAll(/⟦q(\d+)⟧/g)].map(x => normLetter(quotes[Number(x[1])] ?? ''));
      else if (p.ordinal) nums = m[1].split(/\s*(?:,|и)\s*/u).map(w => ORDINALS[w.toLowerCase()]).filter(Boolean);
      else nums = expandNums(m[1]);
      const kind: AddrKind = p.kind === 'b' && nums.length > 0 && nums.every(n => /^([а-я])\1$/u.test(n)) ? 'bb' : p.kind;
      local.push({ kind, nums });
      s = bare.slice(m[0].length);
      matched = true;
      break;
    }
    if (matched) continue;
    for (const [re, part] of PART_PHRASES) {
      m = s.match(re);
      if (!m) continue;
      s = s.slice(m[0].length).trim();
      // "... на Закона за изменение и допълнение на Закона за ... (ДВ, бр. 72 от 2024 г.)"
      const other = s.match(/^(?:към|на)\s+((?:Закона|Кодекса)\s+за\s+.+?)(?=\s+(?:се|в|във|думите|думата|числото|след|пред|накрая|навсякъде|текстът)\s|\s*[,:;]|\s*$)/u);
      if (other) {
        scope.otherAct = other[1];
        s = s.slice(other[0].length);
      } else scope.part = part;
      matched = true;
      break;
    }
    if (!matched) break;
  }
  scope.path = mergePath(scope.path, local);
  return { scope, rest: s.trim() };
}

const ORDER: Record<AddrKind, number> = { art: 0, par: 0, al: 1, t: 2, b: 3, bb: 4, sent: 5, intro: 5 };

/** A child instruction's address replaces the parent's from its level down. */
export function mergePath(parent: Addr[], child: Addr[]): Addr[] {
  if (!child.length) return parent;
  const lvl = ORDER[child[0].kind];
  const keep = parent.filter(a => ORDER[a.kind] < lvl);
  return [...keep, ...child];
}

// ------------------------------------------------------------------ actions

const TOKEN = String.raw`(?:думите|думата|числото|числата|цифрата|цифрите|текстът|текста|съкращението|съкращенията|абревиатурата|абревиаратурата|изразът|годината|сумата|знакът|словата|съюзът|съюзите|местоимението|предлогът|частицата|тирето)`;
const OP_START = new RegExp(String.raw`(?:^|,\s*а\s+|;\s*|,\s+|\s+и\s+|\s+а\s+)(?=(?!текстът\s+до)(?:навсякъде\s+)?(?:${TOKEN}|след|пред|накрая|в\s+края|в\s+началото)(?![\p{L}]))`, 'gu');

function q(quotes: string[], token: string): string {
  const m = token.match(/⟦q(\d+)⟧/);
  return m ? quotes[Number(m[1])] ?? '' : '';
}

function parseWordOp(raw: string, quotes: string[]): WordOp[] | null {
  let s = raw.trim().replace(/[.;,]+$/u, '').trim();
  s = s.replace(/^навсякъде\s+/iu, '');
  let commaBefore = false;
  let commaAfter = false;
  if (/\s+⟨cb⟩/u.test(s)) { commaBefore = true; s = s.replace(/\s+⟨cb⟩/gu, ''); }
  if (/\s+⟨ca⟩/u.test(s)) { commaAfter = true; s = s.replace(/\s+⟨ca⟩/gu, ''); }
  let m: RegExpMatchArray | null;

  // запетаята и думите „…“ се заличават
  if ((m = s.match(new RegExp(String.raw`^запетаята\s+и\s+${TOKEN}\s+(${Q})\s+се\s+заличава(?:т)?$`, 'iu')))) {
    return [{ op: 'delete', text: q(quotes, m[1]), commaBefore: true }];
  }
  // думите „А“ се заменят с „Б“, поставя се запетая и се добавя „В“ и се поставя запетая
  if ((m = s.match(new RegExp(String.raw`^${TOKEN}\s+(${Q})\s+се\s+заменя(?:т)?\s+(?:с|със)\s*(${Q})(?:,?\s+(?:се\s+)?поставя\s+се\s+запетая|,?\s+и\s+се\s+поставя\s+запетая)(?:\s+и\s+се\s+добавя\s+(${Q})(\s+и\s+се\s+поставя\s+запетая)?)?$`, 'iu')))) {
    const to = `${q(quotes, m[2])},${m[3] ? ` ${q(quotes, m[3])}${m[4] ? ',' : ''}` : ''}`;
    return [{ op: 'replace', from: q(quotes, m[1]), to }];
  }
  if ((m = s.match(new RegExp(String.raw`^накрая,?\s+на\s+нов\s+ред\s+се\s+добавя(?:т)?:?\s+(${Q})$`, 'iu')))) {
    return [{ op: 'appendLine', text: q(quotes, m[1]) }];
  }

  // думите „А“ и „Б“ се заменят съответно с „В“ и „Г“
  if ((m = s.match(new RegExp(String.raw`^${TOKEN}\s+(${QLIST})\s+се\s+заменя(?:т)?\s+(?:съответно\s+)?(?:с|със)\s*(?:${TOKEN}\s+)?(${QLIST})$`, 'iu')))) {
    const from = [...m[1].matchAll(/⟦q\d+⟧/g)].map(x => q(quotes, x[0]));
    const to = [...m[2].matchAll(/⟦q\d+⟧/g)].map(x => q(quotes, x[0]));
    if (from.length === to.length) return from.map((f, i) => ({ op: 'replace', from: f, to: to[i], commaBefore }));
    if (to.length === 1) return from.map(f => ({ op: 'replace', from: f, to: to[0], commaBefore }));
    return null;
  }
  if ((m = s.match(new RegExp(String.raw`^${TOKEN}\s+(${QLIST})\s+се\s+(?:заличава(?:т)?|отменя(?:т)?)$`, 'iu')))) {
    return [...m[1].matchAll(/⟦q\d+⟧/g)].map(x => ({ op: 'delete', text: q(quotes, x[0]), commaBefore, commaAfter }));
  }
  if ((m = s.match(new RegExp(String.raw`^след\s+${TOKEN}\s+(${Q})\s+(.+)$`, 'iu')))) {
    const anchor = q(quotes, m[1]);
    const tail = m[2].trim();
    let t: RegExpMatchArray | null;
    if ((t = tail.match(new RegExp(String.raw`^се\s+добавя(?:т)?\s+(${Q})(\s+и\s+се\s+поставя\s+запетая)?$`, 'iu')))) {
      return [{ op: 'insertAfter', anchor, text: q(quotes, t[1]), commaAfter: Boolean(t[2]) }];
    }
    if ((t = tail.match(new RegExp(String.raw`^се\s+поставя\s+запетая(?:,|\s+и)?\s+(?:се\s+добавя(?:т)?|добавя(?:т)?\s+се)\s+(${Q})(\s+и\s+се\s+поставя\s+запетая)?$`, 'iu')))) {
      return [{ op: 'insertAfter', anchor, text: q(quotes, t[1]), commaBefore: true, commaAfter: Boolean(t[2]) }];
    }
    // след думата „ред“ съюзът „или“ се заменя със запетая / запетаята се заменя със съюза „и“
    if ((t = tail.match(new RegExp(String.raw`^(съюзът|запетаята|предлогът|думата|думите|местоимението|частицата)\s*(${Q})?\s+се\s+заменя(?:т)?\s+(?:с|със)\s+(?:(?:съюза|предлога|думата|думите)\s+)?(запетая|точка\s+и\s+запетая|${Q})$`, 'iu')))) {
      const from = t[1].toLowerCase() === 'запетаята' ? ',' : q(quotes, t[2] ?? '');
      const to = /^запетая$/iu.test(t[3]) ? ',' : /^точка/iu.test(t[3]) ? ';' : q(quotes, t[3]);
      if (!from) return null;
      return [{ op: 'replaceAfter', anchor, from, to }];
    }
    // след думите „X“ се поставя запетая и съюзът „и“ се заличава
    if ((t = tail.match(new RegExp(String.raw`^се\s+поставя\s+запетая\s+и\s+(?:съюзът|предлогът|думата)\s+(${Q})\s+се\s+заличава$`, 'iu')))) {
      return [{ op: 'replaceAfter', anchor, from: q(quotes, t[1]), to: ',' }];
    }
    if ((t = tail.match(new RegExp(String.raw`^се\s+поставя\s+тире\s+и\s+се\s+добавя(?:т)?\s+(${Q})$`, 'iu')))) {
      return [{ op: 'insertAfter', anchor, text: q(quotes, t[1]), sep: ' – ' }];
    }
    if (/^се\s+поставя\s+точка\s+и\s+текстът\s+до\s+края\s+(?:на\s+изречението\s+)?се\s+заличава$/iu.test(tail)) {
      return [{ op: 'truncateAfter', anchor }];
    }
    if ((t = tail.match(/^се\s+поставя\s+(запетая|точка\s+и\s+запетая|точка|двоеточие)$/iu))) {
      const punct = { 'запетая': ',', 'точка и запетая': ';', 'точка': '.', 'двоеточие': ':' }[t[1].toLowerCase().replace(/\s+/g, ' ')] ?? ',';
      return [{ op: 'punctAfter', anchor, punct }];
    }
    return null;
  }
  if ((m = s.match(new RegExp(String.raw`^пред\s+${TOKEN}\s+(${Q})\s+се\s+добавя(?:т)?\s+(${Q})$`, 'iu')))) {
    return [{ op: 'insertBefore', anchor: q(quotes, m[1]), text: q(quotes, m[2]) }];
  }
  if ((m = s.match(new RegExp(String.raw`^в\s+началото(?:\s+на\s+изречението)?\s+се\s+добавя(?:т)?:?\s+(${Q})$`, 'iu')))) {
    return [{ op: 'prepend', text: q(quotes, m[1]) }];
  }
  // съюзът „и“ се заменя със запетая
  if ((m = s.match(new RegExp(String.raw`^${TOKEN}\s+(${Q})\s+се\s+заменя(?:т)?\s+(?:с|със)\s+(запетая|точка\s+и\s+запетая)$`, 'iu')))) {
    return [{ op: 'replace', from: q(quotes, m[1]), to: /^запетая/iu.test(m[2]) ? ',' : ';' }];
  }
  if ((m = s.match(new RegExp(String.raw`^(?:накрая|в\s+края)\s+(?:се\s+поставя\s+запетая\s+и\s+)?(?:се\s+добавя(?:т)?|се\s+добавя\s+текст|добавя\s+се):?\s+(${Q})$`, 'iu')))) {
    return [{ op: 'append', text: q(quotes, m[1]), comma: /запетая/u.test(s) }];
  }
  return null;
}

function parseWords(rest: string, quotes: string[]): WordOp[] | null {
  const s = rest
    .replace(/(⟦q\d+⟧)\s+се\s+заменя(т)?\s+(?=⟦q)/gu, '$1 се заменя$2 с ')
    .replace(/\s+(?:и\s+)?запета(?:ята|ите)\s+пред\s+и\s+след\s+(?:тях|него|нея)/giu, ' ⟨cb⟩ ⟨ca⟩')
    .replace(/(се\s+заменя(?:т)?\s+(?:с|със)\s*⟦q\d+⟧)\s+и\s+запетаята\s+пред\s+(?:тях|него|нея)\s+се\s+заличава(?![\p{L}])/giu, '$1 ⟨cb⟩')
    .replace(/\s+и\s+запетаята\s+пред\s+(?:тях|него|нея|него)/giu, ' ⟨cb⟩')
    .replace(/\s+и\s+запетаята\s+след\s+(?:тях|него|нея)/giu, ' ⟨ca⟩');
  // split before each operation keyword, but not inside "се поставя запетая и се добавя"
  const cuts: number[] = [0];
  for (const m of s.matchAll(OP_START)) {
    if (m.index! > 0) cuts.push(m.index!);
  }
  const pieces: string[] = [];
  for (let i = 0; i < cuts.length; i++) pieces.push(s.slice(cuts[i], cuts[i + 1]).replace(/^(?:,\s*а|;|,|\s+и|\s+а)\s+/u, ''));
  const ops: WordOp[] = [];
  for (const p of pieces.map(x => x.trim()).filter(Boolean)) {
    const w = parseWordOp(p, quotes);
    if (!w) return null;
    const prev = ops[ops.length - 1];
    // "след думите „X“ се поставя запетая и съюзът „и“ се заличава" → one edit right after „X“
    if (prev?.op === 'punctAfter' && prev.punct === ',' && w.length === 1 && w[0].op === 'delete' && w[0].text.length <= 4) {
      ops[ops.length - 1] = { op: 'replaceAfter', anchor: prev.anchor, from: w[0].text, to: ',' };
      continue;
    }
    ops.push(...w);
  }
  return ops.length ? ops : null;
}

const ADDR_WORD = String.raw`(?:нова|нов|ново|нови)?\s*(?:чл\.|член|ал\.|алинея|алинеи|т\.|точка|точки|буква|букви|§|параграф|изречение|изречения)`;

function parseAddrPhrase(s: string, quotes: string[]): { addr: Addr; rest: string; isNew: boolean } | null {
  const isNew = /^(?:нова|нов|ново|нови)\s/iu.test(s);
  const t = s.replace(/^(?:нова|нов|ново|нови)\s+/iu, '');
  const p = parseScope(t, quotes, { path: [] });
  if (!p.scope.path.length) return null;
  return { addr: p.scope.path[p.scope.path.length - 1], rest: p.rest, isNew };
}

function quotesIn(s: string, quotes: string[]): string[] {
  return [...s.matchAll(/⟦q(\d+)⟧/g)].map(m => quotes[Number(m[1])] ?? '');
}

export function parseAction(rest: string, quotes: string[]): Action {
  const s = rest.trim().replace(/\s+/g, ' ');
  let m: RegExpMatchArray | null;

  if (/^(?:се\s+правят\s+следните\s+(?:изменения|допълнения|изменение|допълнение)(?:\s+и\s+(?:изменения|допълнения))?)?\s*:?\s*\.?$/iu.test(s)) {
    return { type: 'noop', why: 'container' };
  }
  if ((m = s.match(/^се\s+изменя(?:т)?\s+така:?\s*(.*)$/iu))) {
    const qs = quotesIn(m[1], quotes);
    return qs.length ? { type: 'replace', quotes: qs } : { type: 'unknown', why: 'replacement text missing' };
  }
  if (/^се\s+(?:отменя(?:т)?|заличава(?:т)?)\s*[.;]?$/iu.test(s)) return { type: 'repeal' };

  // създава се нова ал. 3: „…“   /  се създават т. 31 – 34: „…“  / се създава раздел VII с чл. 62а – чл. 62г: „…“
  if ((m = s.match(/^(?:се\s+създава(?:т)?|създава(?:т)?\s+се)\s+(.*)$/iu))) {
    let tail = m[1];
    let razdel: string | undefined;
    const rz = tail.match(/^(?:нов|нова)?\s*(раздел|глава|дял|част|отдел)\s+([IVXLC]+[а-яa-z]?|\d+[а-я]?|[\p{L}]+)(?:\s+⟦q\d+⟧)?\s+(?:с|със)\s+(?:нов(?:и)?\s+)?/iu);
    if (rz) { razdel = rz[1].toLowerCase() === 'раздел' ? rz[2] : `${rz[1]} ${rz[2]}`; tail = tail.slice(rz[0].length); }
    const a = parseAddrPhrase(tail, quotes);
    if (!a) return { type: 'unknown', why: 'cannot read what is created' };
    const qs = quotesIn(a.rest, quotes);
    if (!qs.length) return { type: 'unknown', why: 'new text missing' };
    return { type: 'create', what: a.addr, isNew: a.isNew, quotes: qs, razdel };
  }

  // Досегашният текст става ал. 1
  if ((m = s.match(/^досегашният\s+текст(?:\s+на\s+[^с]+?)?\s+става\s+(ал\.|т\.)\s*1\b(.*)$/iu))) {
    return { type: 'wrap', into: { kind: m[1].startsWith('ал') ? 'al' : 't', nums: ['1'] } };
  }

  // Досегашната т. 3 става т. 4 и в нея …  /  Досегашните ал. 2 и 3 стават съответно ал. 3 и 4
  if ((m = s.match(/^(?:досегашн(?:ият|ата|ото|ите)\s+)?(.+?)\s+став(?:а|ат)\s+(?:съответно\s+)?(.+)$/iu))) {
    const from = parseAddrPhrase(m[1], quotes);
    const toP = parseAddrPhrase(m[2], quotes);
    if (from && toP && from.rest === '') {
      let then: Action | undefined;
      const tail = toP.rest.trim().replace(/^[.;,]+$/u, "");
      if (tail) {
        const t = tail.match(/^(?:и|,)\s+(?:в\s+(?:нея|него|тях)\s+)?(.*)$/iu);
        if (!t) return { type: 'unknown', why: `cannot read "${tail}"` };
        // "… и в нея т. 2 се изменя така: …" — the follow-up may name a unit inside the renumbered one
        const sub = parseScope(t[1], quotes, { path: [] });
        then = parseAction(sub.rest, quotes);
        if (then.type === 'unknown') {
          const w = parseWords(sub.rest, quotes);
          then = w ? { type: 'words', ops: w } : then;
        }
        if (then.type === 'noop' && then.why === 'container') then = undefined;
        if (sub.scope.path.length) {
          if (from.addr.kind === 'sent') return { type: 'noop', why: 'sentence renumbered' };
          return { type: 'renumber', from: from.addr, to: toP.addr, then, thenPath: sub.scope.path };
        }
      }
      if (from.addr.kind === 'sent') return { type: 'noop', why: 'sentence renumbered' };
      return { type: 'renumber', from: from.addr, to: toP.addr, then };
    }
  }

  const w = parseWords(s, quotes);
  if (w) return { type: 'words', ops: w };
  return { type: 'unknown', why: 'instruction not recognised' };
}

// ------------------------------------------------------------------ section → ops

const LAW_REF = /^\s*(?:§|Чл\.)\s*\d+[а-я]?\s*\.\s*(?:\(\d+\)\s*)?/u;

/** Remove "(обн., ДВ, бр. … )" style parentheticals (balanced). */
export function stripGazetteParens(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '(' && /^\((?:обн\.|ДВ|изм\.|попр\.|Обн\.)/u.test(s.slice(i, i + 8))) {
      let depth = 0;
      let j = i;
      for (; j < s.length; j++) {
        if (s[j] === '(') depth++;
        else if (s[j] === ')') { depth--; if (depth === 0) break; }
      }
      i = j + 1;
      continue;
    }
    out += s[i++];
  }
  return out.replace(/[ \t]{2,}/g, ' ');
}

/** Split "X…, а в изречение второ Y…" into separate instructions. */
function splitClauses(rest: string): string[] {
  return rest.split(/,\s*а\s+(?=(?:в\s+)?(?:изречение|изречения|ал\.|т\.|буква|текста|алинея|точка)\s)/u).map(x => x.trim()).filter(Boolean);
}

/**
 * Parse a § of an amending act. `lawGenitives` are the names of the law in the genitive
 * ("Закона за счетоводството") — for indirect amendments the § starts with them.
 */
export function parseSection(sectionText: string, lawGenitives: string[]): Op[] {
  const { text, quotes } = extractQuotes(sectionText.replace(LAW_REF, ''));
  let body = stripGazetteParens(text).replace(/\n\s*Законът\s+е\s+приет\s+от[\s\S]*$/u, '').trim();
  // leading "В Закона за X" / "В чл. 5 от Закона за X"
  for (const g of [...lawGenitives].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(String.raw`^(В\s+(?:(.{0,120}?)\s+от\s+)?)${g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(?![\p{L}])\s*`, 'u');
    const m = body.match(re);
    if (m) {
      body = (m[2] ? `в ${m[2]} ` : '') + body.slice(m[0].length);
      break;
    }
  }
  const items = splitItems(body);
  const ops: Op[] = [];
  const visit = (it: Item, base: Scope, item?: string) => {
    const raw = it.text.trim();
    const own = it.level === 1 ? it.num : item;
    const { scope, rest } = parseScope(raw, quotes, base);
    const action = parseAction(rest, quotes);
    if (action.type === 'noop' && action.why === 'container') {
      for (const c of it.children) visit(c, scope, own);
      if (!it.children.length && raw) ops.push({ scope, action: { type: 'unknown', why: 'empty instruction' }, source: restoreQuotes(raw, quotes), item: own });
      return;
    }
    // "…, а изречение второ се заличава" / "…, а в ал. 2 думите …": a second instruction with its own place
    const split = action.type === 'unknown' ? splitClauses(rest) : null;
    if (split && split.length > 1) {
      let ok = true;
      const parts: Op[] = [];
      split.forEach((seg, i) => {
        const sp = i === 0 ? { scope, rest: seg } : parseScope(seg, quotes, { ...scope, path: scope.path.filter(a => a.kind !== 'sent' && a.kind !== 'intro') });
        const a = parseAction(sp.rest, quotes);
        if (a.type === 'unknown') ok = false;
        parts.push({ scope: sp.scope, action: a, source: restoreQuotes(raw, quotes), item: own });
      });
      if (ok) {
        ops.push(...parts);
        for (const c of it.children) visit(c, scope, own);
        return;
      }
    }
    ops.push({ scope, action, source: restoreQuotes(raw, quotes), item: own });
    const childScope = action.type === 'renumber'
      ? { ...scope, path: mergePath(scope.path, [{ kind: action.to.kind, nums: action.to.nums }]) }
      : scope;
    for (const c of it.children) visit(c, childScope, own);
  };
  visit(items, { path: [] });
  return ops;
}

/** Parse "(обн., ДВ, бр. 95 от 2015 г.; изм., бр. 74, 95 и 97 от 2016 г., …)" into gazette issues. */
export function parseAmendmentChain(text: string): { published?: string; amended: string[] } | null {
  const m = text.match(/\((?:обн\.,\s*)?ДВ,\s*бр\.\s*(\d+)\s*от\s*(\d{4})\s*г\.([^()]*(?:\([^()]*\)[^()]*)*)\)/u);
  if (!m) return null;
  const published = `${m[1]}/${m[2]}`;
  const tail = m[3];
  const amended: string[] = [];
  const iz = tail.indexOf('изм.');
  if (iz >= 0) {
    for (const g of tail.slice(iz).matchAll(/бр\.\s*([\d,\sи]+?)\s*от\s*(\d{4})\s*г\./gu)) {
      for (const n of g[1].split(/\s*(?:,|\sи\s)\s*/u).map(x => x.trim()).filter(Boolean)) amended.push(`${n}/${g[2]}`);
    }
  }
  return { published, amended };
}
