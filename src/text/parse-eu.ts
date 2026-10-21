/**
 * Parser for EU acts in Bulgarian, as published on EUR-Lex (HTML → lines).
 * EU articles are headed "Член N" on their own line, usually followed by a title line.
 */
import type { ParsedProvision } from './parse-bg.js';

const ARTICLE = /^Член\s+(\d+[а-я]?)$/u;
const ANNEX = /^ПРИЛОЖЕНИЕ(?:\s+([IVXLCDM]+|\d+))?$/u;
const CHAPTER = /^(ГЛАВА|ДЯЛ|РАЗДЕЛ)\s+[IVXLCDM\d]+$/u;

export function parseEuAct(lines: string[]): ParsedProvision[] {
  const out: ParsedProvision[] = [];
  let current: { kind: 'art' | 'body'; num: string; label: string; chapter?: string; lines: string[] } | null = null;
  let chapter: string | undefined;
  let started = false;
  let annexCount = 0;

  const flush = () => {
    if (current && current.lines.length) {
      out.push({
        ord: out.length + 1,
        kind: current.kind,
        num: current.num,
        part: 'main',
        partKey: current.kind === 'art' ? 'main' : 'annex',
        chapter: current.chapter,
        label: current.label,
        text: current.lines.join('\n'),
      });
    }
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (CHAPTER.test(line)) {
      flush();
      const next = lines[i + 1];
      chapter = next && !ARTICLE.test(next) ? `${line} — ${next}` : line;
      if (next && !ARTICLE.test(next)) i++;
      continue;
    }

    // Once the annexes start, "Член N" lines are quotations or correlation tables, not articles.
    const art = annexCount === 0 ? line.match(ARTICLE) : null;
    if (art) {
      flush();
      started = true;
      const num = art[1];
      const title = lines[i + 1] && !ARTICLE.test(lines[i + 1]) && lines[i + 1].length < 200 ? lines[i + 1] : undefined;
      current = { kind: 'art', num, label: `Член ${num}`, chapter, lines: [title ? `Член ${num} — ${title}` : `Член ${num}`] };
      if (title) i++;
      continue;
    }

    const annex = line.match(ANNEX);
    if (annex && started) {
      flush();
      annexCount += 1;
      const num = annex[1] ?? String(annexCount);
      current = { kind: 'body', num: `annex-${num}`, label: `Приложение ${num}`, lines: [line] };
      continue;
    }

    if (current) current.lines.push(line);
  }
  flush();
  return out;
}

/** Pull the act's title: the first long line containing РЕГЛАМЕНТ / ДИРЕКТИВА. */
export function extractEuTitle(lines: string[]): string | undefined {
  for (let i = 0; i < Math.min(lines.length, 60); i++) {
    if (/^(РЕГЛАМЕНТ|ДИРЕКТИВА|РЕШЕНИЕ)/u.test(lines[i])) {
      const parts = [lines[i]];
      // EUR-Lex splits "РЕГЛАМЕНТ (ЕС) 2016/679 НА ЕВРОПЕЙСКИЯ ПАРЛАМЕНТ..." over a few lines.
      for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
        if (/^(от|относно|за)\s/u.test(lines[j]) || lines[j] === lines[j].toUpperCase()) parts.push(lines[j]);
        else break;
      }
      return parts.join(' ');
    }
  }
  return undefined;
}
