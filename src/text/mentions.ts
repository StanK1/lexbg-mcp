/**
 * Does a piece of amending text really mention article N of THIS law?
 *
 * "§ 15. В Закона за счетоводството (...) се правят изменения: ... такси по чл. 12, ал. 1, т. 1
 *  от Закона за търговския регистър ..." mentions чл. 12 — but of ANOTHER law. Treat a mention
 * as foreign when it is followed (after ал./т./буква/и + numbers) by "от <other law>".
 */

const LAW_START = /^(?:допълнителните|преходните|заключителните|преходните\s+и\s+заключителните)?\s*(?:разпоредби\s+(?:на|към)\s+)?(Закона|Кодекса|Конституцията|Регламент|Директива|Търговския|Данъчно|Наказателния|Гражданския|Семейния|Изборния|Административнопроцесуалния|Закон|Правилника|Наредба)/u;
const CITATION_GLUE = /^(?:[\s,.;–\-\d()„“]|ал\.|т\.|изр\.|букв[аи]|и(?=\s))*/u;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
}

export function articleMentionRegex(kind: 'art' | 'par', num: string): RegExp {
  const n = escapeRe(num.toLowerCase());
  return kind === 'art'
    ? new RegExp(`(?<![\\p{L}\\d])чл\\.\\s*${n}(?![\\dа-я])`, 'giu')
    : new RegExp(`(?<![\\p{L}\\d])§\\s*${n}(?![\\dа-я])`, 'giu');
}

/**
 * @param ownNames genitive names of the law the mention should belong to (e.g. "Закона за счетоводството")
 */
export function mentionsProvision(text: string, kind: 'art' | 'par', num: string, ownNames: string[]): boolean {
  const re = articleMentionRegex(kind, num);
  for (const m of text.matchAll(re)) {
    const tail = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 240);
    const glue = tail.match(CITATION_GLUE)?.[0] ?? '';
    const rest = tail.slice(glue.length);
    const fromMatch = rest.match(/^от\s+([\s\S]*)$/u);
    if (!fromMatch) return true; // "в чл. 12 ..." — refers to the law being amended
    const target = fromMatch[1];
    if (!LAW_START.test(target)) return true; // "от ... " not followed by a law name
    if (ownNames.some(name => new RegExp(`^(?:[^„]{0,60}?\\s)?${escapeRe(name)}(?![\\p{L}])`, 'u').test(target))) return true;
    // otherwise it is an article of another law — keep looking for a genuine mention
  }
  return false;
}

/** Drop the leading "§ 38." / "Чл. 5." of a section so its own number doesn't count as a mention. */
export function withoutOwnNumber(text: string): string {
  return text.replace(/^(?:§|Чл\.)\s*\d+[а-я]?\.\s*/u, '');
}
