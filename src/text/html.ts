/**
 * Minimal, dependency-free HTML → text-lines conversion for legislative pages.
 * Block-level tags become line breaks; everything else is stripped.
 */

const ENTITIES: Record<string, string> = {
  nbsp: ' ', shy: '', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  bdquo: '„', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  ndash: '–', mdash: '—', hellip: '…', sect: '§', middot: '·',
};

export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (m, hex) => safeCodePoint(Number.parseInt(hex, 16), m))
    .replace(/&#(\d+);/g, (m, dec) => safeCodePoint(Number.parseInt(dec, 10), m))
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITIES[name] ?? m);
}

function safeCodePoint(cp: number, fallback: string): string {
  try {
    return Number.isFinite(cp) ? String.fromCodePoint(cp) : fallback;
  } catch {
    return fallback;
  }
}

export function normalizeSpace(text: string): string {
  return text.replace(/[   ]/g, ' ').replace(/[ \t\f\v]+/g, ' ').trim();
}

export function htmlToLines(html: string): string[] {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|tr|h[1-6]|table|section|article|blockquote)\s*>/gi, '\n')
    .replace(/<\s*(p|div|li|tr|h[1-6])(\s[^>]*)?>/gi, '\n');

  const plain = decodeEntities(cleaned.replace(/<[^>]+>/g, ' ')).replace(/\r/g, '');
  return textToLines(plain);
}

export function textToLines(text: string): string[] {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .map(normalizeSpace)
    .filter(line => line.length > 0);
}

/** Lowercase + collapse whitespace; used for verbatim-quote checks. */
export function canonical(text: string): string {
  return normalizeSpace(text.replace(/\s+/g, ' ')).toLowerCase();
}
