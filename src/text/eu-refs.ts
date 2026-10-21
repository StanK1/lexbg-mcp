/**
 * Detect references to EU regulations and directives in Bulgarian legal text
 * and convert them to CELEX numbers (e.g. "Регламент (ЕС) 2016/679" → 32016R0679).
 */

export interface EuReference {
  celex: string;
  type: 'R' | 'L';
  year: number;
  number: number;
  text: string;
}

// "Регламент (ЕС) 2016/679", "Регламент (ЕС) № 575/2013", "Регламент (ЕО) № 1606/2002"
const REGULATION = /Регламент(?:а|ът)?\s*\((ЕС|ЕО|ЕИО|ЕС,\s*Евратом)\)\s*(?:№\s*)?(\d{1,4})\/(\d{1,4})/gu;
// "Директива (ЕС) 2015/849", "Директива 2006/112/ЕО", "Директива 2013/34/ЕС"
const DIRECTIVE_NEW = /Директива(?:та)?\s*\((ЕС|ЕО|ЕИО)\)\s*(\d{4})\/(\d{1,4})/gu;
const DIRECTIVE_OLD = /Директива(?:та)?\s*(?:№\s*)?(\d{2,4})\/(\d{1,4})\/(ЕС|ЕО|ЕИО)/gu;

function fullYear(y: number): number {
  if (y >= 1000) return y;
  return y >= 50 ? 1900 + y : 2000 + y;
}

function isYear(n: number, digits: number): boolean {
  return digits === 4 && n >= 1950 && n <= 2100;
}

export function celexFor(type: 'R' | 'L', year: number, number: number): string {
  return `3${year}${type}${String(number).padStart(4, '0')}`;
}

export function extractEuReferences(text: string): EuReference[] {
  const found = new Map<string, EuReference>();

  for (const m of text.matchAll(REGULATION)) {
    const a = m[2];
    const b = m[3];
    const na = Number(a);
    const nb = Number(b);
    let year: number;
    let num: number;
    // Since 2015 EU acts are numbered YEAR/NUMBER; older regulations NUMBER/YEAR.
    if (isYear(na, a.length) && na >= 2015) {
      year = na; num = nb;
    } else if (isYear(nb, b.length)) {
      year = nb; num = na;
    } else if (isYear(na, a.length)) {
      year = na; num = nb;
    } else {
      continue;
    }
    add(found, 'R', year, num, m[0]);
  }

  for (const m of text.matchAll(DIRECTIVE_NEW)) {
    add(found, 'L', Number(m[2]), Number(m[3]), m[0]);
  }

  for (const m of text.matchAll(DIRECTIVE_OLD)) {
    const y = Number(m[1]);
    add(found, 'L', fullYear(y), Number(m[2]), m[0]);
  }

  return [...found.values()];
}

function add(map: Map<string, EuReference>, type: 'R' | 'L', year: number, number: number, text: string) {
  if (!Number.isFinite(year) || !Number.isFinite(number) || number <= 0) return;
  const celex = celexFor(type, year, number);
  if (!map.has(celex)) map.set(celex, { celex, type, year, number, text });
}

/** Normalise user input like "2016/679", "GDPR", "32016R0679", "Регламент (ЕС) 2016/679". */
export function normalizeCelexInput(input: string, aliases: Record<string, string>): string | null {
  const trimmed = input.trim();
  const alias = aliases[trimmed.toLowerCase()];
  if (alias) return alias;
  if (/^3\d{4}[RL]\d{4}$/i.test(trimmed)) return trimmed.toUpperCase();
  const refs = extractEuReferences(trimmed);
  if (refs.length) return refs[0].celex;
  const bare = trimmed.match(/^(\d{4})\/(\d{1,4})$/);
  if (bare) return null; // ambiguous: regulation or directive
  return null;
}
