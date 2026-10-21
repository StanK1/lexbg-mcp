/**
 * Parse Bulgarian and EU-style legal citations.
 *
 *   "чл. 6, ал. 1, т. 2 от ЗЗЛД"
 *   "чл.6а ал.2 ЗСч"
 *   "§ 1, т. 5 от ДР на Закона за счетоводството"
 *   "Член 6 от Регламент (ЕС) 2016/679", "art. 6(1) GDPR"
 */
import type { PartCode, ProvisionKind } from './parse-bg.js';

export interface ParsedCitation {
  kind: ProvisionKind;
  num: string;
  alineya?: string;
  point?: string;
  part?: PartCode;
  /** Whatever is left after removing the provision reference: the law name/abbreviation. */
  lawText: string;
  raw: string;
}

const ART = /(?:^|[\s,(])(?:чл\.?|член|art\.?|article)\s*(\d+[а-яa-z]?)(?:\s*\((\d+[а-я]?)\))?/iu;
const PAR = /(?:^|[\s,(])§\s*(\d+[а-я]?)/u;
const ALINEYA = /(?<!\p{L})(?:ал\.?|алинея|para\.?|paragraph)\s*(\d+[а-я]?)/iu;
const POINT = /(?<!\p{L})(?:т\.|точка|point)\s*(\d+[а-я]?)/iu;

const PART_PATTERNS: Array<[RegExp, PartCode]> = [
  [/(?<!\p{L})ПЗР(?!\p{L})|преходн\S*\s+и\s+заключителн\S*(?:\s+разпоредб\S*)?/iu, 'pzr'],
  [/(?<!\p{L})ДР(?!\p{L})|допълнителн\S*\s+разпоредб\S*/iu, 'dr'],
  [/(?<!\p{L})ПР(?!\p{L})|преходн\S*\s+разпоредб\S*/iu, 'pr'],
  [/(?<!\p{L})ЗР(?!\p{L})|заключителн\S*\s+разпоредб\S*/iu, 'zr'],
];

export function parseCitation(input: string): ParsedCitation | null {
  const raw = input.trim();
  let rest = ` ${raw} `;
  let kind: ProvisionKind;
  let num: string;
  let alineya: string | undefined;
  let point: string | undefined;
  let part: PartCode | undefined;

  const par = rest.match(PAR);
  const art = rest.match(ART);
  if (par && (!art || (par.index ?? 0) < (art.index ?? 0))) {
    kind = 'par';
    num = par[1].toLowerCase();
    rest = rest.replace(par[0], ' ');
    for (const [re, code] of PART_PATTERNS) {
      const m = rest.match(re);
      if (m) {
        part = code;
        rest = rest.replace(m[0], ' ');
        break;
      }
    }
  } else if (art) {
    kind = 'art';
    num = art[1].toLowerCase();
    if (art[2]) alineya = art[2];
    rest = rest.replace(art[0], ' ');
  } else {
    return null;
  }

  const al = rest.match(ALINEYA);
  if (al) {
    alineya = al[1];
    rest = rest.replace(al[0], ' ');
  }
  const pt = rest.match(POINT);
  if (pt) {
    point = pt[1];
    rest = rest.replace(pt[0], ' ');
  }

  const lawText = rest
    .replace(/(?<!\p{L})(от|на|of|from)(?!\p{L})/giu, ' ')
    .replace(/[,;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { kind, num, alineya, point, part, lawText, raw };
}

export function formatCitation(c: { kind: ProvisionKind; num: string; alineya?: string; point?: string; part?: PartCode }, lawShort: string): string {
  const bits: string[] = [];
  if (c.kind === 'art') bits.push(`чл. ${c.num}`);
  else if (c.kind === 'par') bits.push(`§ ${c.num}`);
  else bits.push(`текст ${c.num}`);
  if (c.alineya) bits.push(`ал. ${c.alineya}`);
  if (c.point) bits.push(`т. ${c.point}`);
  let s = bits.join(', ');
  if (c.kind === 'par' && c.part && c.part !== 'main') {
    s += ` от ${({ dr: 'ДР', pzr: 'ПЗР', pr: 'ПР', zr: 'ЗР' } as const)[c.part]} на ${lawShort}`;
  } else {
    s += ` ${lawShort}`;
  }
  return s;
}
