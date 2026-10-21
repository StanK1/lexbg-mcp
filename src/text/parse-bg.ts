/**
 * Parser for Bulgarian normative acts (laws, codes, amending acts).
 *
 * Unlike a naive "split on Чл." parser, this keeps the act's structure:
 *  - articles (Чл. N) in the main body,
 *  - paragraphs (§ N) in the Additional / Transitional / Final provisions,
 *    which restart numbering in every part and often hold the definitions
 *    (e.g. "§ 1. По смисъла на този закон..."),
 *  - § N units in amending acts, which have no articles at all.
 */

export type ProvisionKind = 'art' | 'par' | 'body';
export type PartCode = 'main' | 'dr' | 'pzr' | 'pr' | 'zr';

export interface ParsedProvision {
  ord: number;
  kind: ProvisionKind;
  num: string;
  part: PartCode;
  /** Unique part key within the act: 'main', 'dr', 'pzr', 'pzr#2', ... */
  partKey: string;
  partTitle?: string;
  chapter?: string;
  label: string;
  text: string;
}

const PART_LABEL: Record<PartCode, string> = {
  main: '',
  dr: 'ДР',
  pzr: 'ПЗР',
  pr: 'ПР',
  zr: 'ЗР',
};

const PART_HEADING =
  /^(допълнителн[аи]|преходн[аи](?:\s+и\s+заключителн[аи])?|заключителн[аи])\s+разпоредб[аи](?:\s+(?:към|на)\s+.+)?$/iu;

const CHAPTER_HEADING = /^(глава|раздел|отдел|част)(?![\p{L}\p{N}])\s*.*$/iu;
const ARTICLE = /^Чл\.\s*(\d+[а-яё]?)\s*\.\s*(.*)$/u;
const PARAGRAPH = /^§\s*(\d+[а-яё]?)\s*\.\s*(.*)$/u;

export function detectPart(line: string): PartCode | null {
  const m = line.match(PART_HEADING);
  if (!m) return null;
  const head = m[1].toLowerCase();
  if (head.startsWith('допълнителн')) return 'dr';
  if (head.startsWith('преходн') && head.includes('заключителн')) return 'pzr';
  if (head.startsWith('преходн')) return 'pr';
  return 'zr';
}

function isChapterHeading(line: string): boolean {
  if (line.length > 200) return false;
  if (!CHAPTER_HEADING.test(line)) return false;
  // "Глава първа", "ГЛАВА ВТОРА", "Раздел I" — but not prose like "Главата на ..."
  const first = line.split(/\s+/)[0].toLowerCase();
  return ['глава', 'раздел', 'отдел', 'част'].includes(first);
}

function isSubtitle(line: string): boolean {
  if (line.length < 2 || line.length > 160) return false;
  if (ARTICLE.test(line) || PARAGRAPH.test(line)) return false;
  const letters = line.replace(/[^\p{L}]/gu, '');
  if (letters.length < 2) return false;
  // Subtitles are usually ALL CAPS or short title-case lines without a final period.
  const upper = letters === letters.toUpperCase();
  return upper || (!/[.;:]$/.test(line) && line.split(/\s+/).length <= 14);
}

export function makeLabel(kind: ProvisionKind, num: string, part: PartCode): string {
  if (kind === 'art') return `Чл. ${num}`;
  if (kind === 'body') return `Текст (част ${num})`;
  const suffix = PART_LABEL[part];
  return suffix ? `§ ${num} ${suffix}` : `§ ${num}`;
}

const BODY_CHUNK = 4000;

export function parseBulgarianAct(lines: string[]): ParsedProvision[] {
  const out: ParsedProvision[] = [];
  const partCounts = new Map<PartCode, number>();
  const seen = new Set<string>();

  let part: PartCode = 'main';
  let partKey = 'main';
  let partTitle: string | undefined;
  let chapter: string | undefined;
  let awaitingSubtitle = false;
  // Amending acts are made of § units; a line like "Чл. 52б. ..." inside them is quoted
  // new text being inserted into the amended law, not a unit of the act itself.
  let mainUsesParagraphs = false;
  let sawMainUnit = false;
  let current: Omit<ParsedProvision, 'text' | 'ord'> & { lines: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const text = current.lines.join('\n').trim();
    if (text) {
      let key = `${current.kind}|${current.num}|${current.partKey}`;
      let dup = 1;
      while (seen.has(key)) {
        dup += 1;
        key = `${current.kind}|${current.num}|${current.partKey}~${dup}`;
      }
      seen.add(key);
      const finalPartKey = dup > 1 ? `${current.partKey}~${dup}` : current.partKey;
      out.push({
        ord: out.length + 1,
        kind: current.kind,
        num: current.num,
        part: current.part,
        partKey: finalPartKey,
        partTitle: current.partTitle,
        chapter: current.chapter,
        label: current.label,
        text,
      });
    }
    current = null;
  };

  for (const line of lines) {
    const partCode = detectPart(line);
    if (partCode) {
      flush();
      const n = (partCounts.get(partCode) ?? 0) + 1;
      partCounts.set(partCode, n);
      part = partCode;
      partKey = n === 1 ? partCode : `${partCode}#${n}`;
      partTitle = line;
      chapter = undefined;
      awaitingSubtitle = false;
      continue;
    }

    if (isChapterHeading(line)) {
      flush();
      chapter = line;
      awaitingSubtitle = true;
      continue;
    }

    if (awaitingSubtitle && isSubtitle(line)) {
      chapter = `${chapter} — ${line}`;
      awaitingSubtitle = false;
      continue;
    }
    awaitingSubtitle = false;

    const art = part === 'main' && !mainUsesParagraphs ? line.match(ARTICLE) : null;
    if (art) {
      sawMainUnit = true;
      flush();
      const num = art[1].toLowerCase();
      current = {
        kind: 'art', num, part, partKey, partTitle, chapter,
        label: makeLabel('art', num, part), lines: [line],
      };
      continue;
    }

    const par = line.match(PARAGRAPH);
    if (par) {
      if (part === 'main' && !sawMainUnit) mainUsesParagraphs = true;
      sawMainUnit = true;
      flush();
      const num = par[1].toLowerCase();
      current = {
        kind: 'par', num, part, partKey, partTitle, chapter,
        label: makeLabel('par', num, part), lines: [line],
      };
      continue;
    }

    if (current) {
      current.lines.push(line);
    }
  }
  flush();

  if (out.length > 0) return out;
  return chunkBody(lines);
}

function chunkBody(lines: string[]): ParsedProvision[] {
  const out: ParsedProvision[] = [];
  let buf: string[] = [];
  let size = 0;
  const push = () => {
    if (!buf.length) return;
    const num = String(out.length + 1);
    out.push({
      ord: out.length + 1, kind: 'body', num, part: 'main', partKey: 'main',
      label: makeLabel('body', num, 'main'), text: buf.join('\n'),
    });
    buf = [];
    size = 0;
  };
  for (const line of lines) {
    if (size + line.length > BODY_CHUNK && buf.length) push();
    buf.push(line);
    size += line.length + 1;
  }
  push();
  return out;
}

/**
 * Extract one numbered paragraph "(N) ..." (алинея) from an article's text.
 * Returns null if the article is not divided into paragraphs.
 */
export function extractParagraph(text: string, alineya: string): string | null {
  const lines = text.split('\n');
  const marker = new RegExp(`^(?:Чл\\.\\s*\\d+[а-я]?\\.\\s*)?(?:\\([^)]*\\)\\s*)?\\(${escapeRe(alineya)}\\)\\s`, 'u');
  const anyMarker = /^(?:Чл\.\s*\d+[а-я]?\.\s*)?(?:\((?:Изм|Нова|Доп|Отм)[^)]*\)\s*)?\((\d+[а-я]?)\)\s/u;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (marker.test(lines[i])) { start = i; break; }
  }
  if (start === -1) return null;
  const chunk = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(anyMarker);
    if (m && m[1] !== alineya) break;
    chunk.push(lines[i]);
  }
  return chunk.join('\n');
}

/** Extract one point "N. ..." (точка) from a text block. */
export function extractPoint(text: string, point: string): string | null {
  const lines = text.split('\n');
  const marker = new RegExp(`^(?:\\(\\d+[а-я]?\\)\\s*)?${escapeRe(point)}\\.\\s`, 'u');
  const anyPoint = /^(\d+[а-я]?)\.\s/u;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (marker.test(lines[i])) { start = i; break; }
  }
  if (start === -1) return null;
  const chunk = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    if (anyPoint.test(lines[i]) || /^\(\d+[а-я]?\)\s/u.test(lines[i])) break;
    chunk.push(lines[i]);
  }
  return chunk.join('\n');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
