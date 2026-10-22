/**
 * Minimal .docx reader: the paragraphs of word/document.xml as plain text. A .docx file is a
 * ZIP archive; this reads its central directory and inflates the one entry it needs, so no
 * extra dependency is required.
 */
import * as zlib from 'node:zlib';

function entry(buf: Buffer, wanted: string): Buffer | null {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a ZIP / .docx file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    if (name === wanted) {
      const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
      const data = buf.subarray(start, start + csize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`unsupported ZIP compression method ${method}`);
    }
    p += 46 + nlen + xlen + clen;
  }
  return null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (_, e: string) =>
    e.startsWith('#x') ? String.fromCodePoint(parseInt(e.slice(2), 16))
      : e.startsWith('#') ? String.fromCodePoint(Number(e.slice(1)))
        : ENTITIES[e.toLowerCase()] ?? _);
}

/** Paragraph texts of a .docx document, in order (empty paragraphs dropped). */
export function docxParagraphs(buf: Buffer): string[] {
  const xml = entry(buf, 'word/document.xml');
  if (!xml) throw new Error('word/document.xml not found');
  return xml.toString('utf8')
    .split(/<\/w:p>/u)
    .map(p => decode(p
      .replace(/<w:tab\/>/gu, ' ')
      .replace(/<w:br\/>/gu, ' ')
      .replace(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<[^>]+>/gu, (_, t?: string) => t ?? ''))
      .replace(/\s+/gu, ' ')
      .trim())
    .filter(Boolean);
}
