/**
 * Helpers for consolidated texts published by institutions (НАП, МФ, МТСП, …), usually as PDF:
 *  - re-flow PDF lines into one line per unit (Чл. / (1) / 1. / а) / headings),
 *  - read the "Обн. ДВ … изм. ДВ …" header to find the last State Gazette issue included,
 * so LexBG can apply only the amending acts published after it.
 */

const UNIT_START = [
  /^„/u,
  /^Чл\.\s*\d+[а-яa-z]*\s*\./u,
  /^§\s*\d+[а-яa-z]*\s*\./u,
  /^\(\d+[а-яa-z]?\)\s/u,
  /^\d+[а-яa-z]?\.\s/u,
  /^[а-яa-z]{1,2}\)\s/u,
  /^(?:Глава|ГЛАВА|Раздел|РАЗДЕЛ|Част|ЧАСТ|Дял|ДЯЛ|Отдел|ОТДЕЛ)\s/u,
  /^(?:ДОПЪЛНИТЕЛН|ПРЕХОДН|ЗАКЛЮЧИТЕЛН|Допълнителн|Преходн|Заключителн)/u,
];

function isHeadingLine(l: string): boolean {
  const letters = l.replace(/[^\p{L}]/gu, '');
  return letters.length >= 3 && letters === letters.toUpperCase() && l.length < 160;
}

/** Page furniture: page numbers, "стр. 3 от 120", repeated running headers. */
function isFurniture(l: string): boolean {
  return /^\d{1,4}$/u.test(l) || /^(?:стр\.|страница)\s*\d+(?:\s*(?:от|\/)\s*\d+)?$/iu.test(l) || /^-\s*\d+\s*-$/u.test(l);
}

/**
 * Join wrapped PDF lines: a line continues the previous one unless it starts a new unit
 * (article, алинея, точка, буква, heading) or the previous line ended a sentence before a heading.
 */
/**
 * Article titles ("Обект на облагане" before "Чл. 2.") are headings of the next article, not
 * text of the previous one. LexBG does not store them (the parliament.bg texts have no place
 * for them either), so they are dropped instead of being glued to the end of an article.
 */
export function isArticleTitle(line: string, next: string | undefined): boolean {
  if (!next || !/^Чл\.\s*\d/u.test(next)) return false;
  if (UNIT_START.some(re => re.test(line)) || isHeadingLine(line)) return false;
  return line.length <= 160 && !/[.;:,]$/u.test(line);
}

/** Paragraph-based sources (.docx, HTML): drop article titles and page furniture. */
export function cleanParagraphs(lines: string[]): string[] {
  const l = lines.map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return l.filter((x, i) => !isFurniture(x) && !isArticleTitle(x, l[i + 1]));
}

export function reflowLines(raw: string[]): string[] {
  const out: string[] = [];
  const lines = raw.map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isFurniture(line)) continue;
    if (isArticleTitle(line, lines[i + 1]) && out.length && /[.;:]$/u.test(out[out.length - 1])) continue;
    const starts = UNIT_START.some(re => re.test(line)) || isHeadingLine(line);
    const prev = out[out.length - 1];
    // "Раздел I" / "Глава пета" on its own line: the next line is its title, not a continuation
    const prevIsShortHeading = prev ? /^(?:Глава|ГЛАВА|Раздел|РАЗДЕЛ|Част|ЧАСТ|Дял|ДЯЛ|Отдел|ОТДЕЛ)\s+[\p{L}IVXLCІ]+(?:\s+„?[\p{L}]“?)?$/u.test(prev) : false;
    if (!prev || starts || isHeadingLine(prev) || prevIsShortHeading) {
      out.push(line);
      continue;
    }
    // a line broken after a hyphen or slash ("най-" / "малко", "и/" / "или"): join without a space,
    // keeping the hyphen — legal texts are not hyphenated for layout, compounds like "най-малко" are
    if (/[\p{L}][-/]$/u.test(prev) && /^[\p{Ll}]/u.test(line)) out[out.length - 1] = prev + line;
    else out[out.length - 1] = `${prev} ${line}`;
  }
  return out;
}

const MONTH_WORDS = 'януари|февруари|март|април|май|юни|юли|август|септември|октомври|ноември|декември';

/**
 * The State Gazette issues listed in the header of a consolidated text, e.g.
 *   "Обн. ДВ. бр.95 от 8 Декември 2015г., изм. ДВ. бр.74 от 20 Септември 2016г., …"
 *   "Обн., ДВ, бр. 95 от 8.12.2015 г., … изм. и доп., бр. 72 от 27.08.2024 г."
 * Returns issues as "95/2015" in order, the first one being the original publication.
 */
export function headerIssues(text: string): string[] {
  const firstArticle = text.search(/(?:^|\n)\s*Чл\.\s*1\s*\./u);
  const head = (firstArticle > 0 ? text.slice(0, firstArticle) : text.slice(0, 6000)).replace(/\s+/g, ' ');
  const re = new RegExp(String.raw`бр\.\s*(\d+)\s*(?:от|/)\s*(?:\d{1,2}\s*(?:${MONTH_WORDS})\s*|\d{1,2}\.\d{1,2}\.)?\s*(\d{4})`, 'giu');
  const out: string[] = [];
  for (const m of head.matchAll(re)) {
    const iss = `${Number(m[1])}/${m[2]}`;
    if (!out.includes(iss)) out.push(iss);
  }
  return out;
}

export function compareIssues(a: string, b: string): number {
  const [na, ya] = a.split('/').map(Number);
  const [nb, yb] = b.split('/').map(Number);
  return ya - yb || na - nb;
}

/** Latest issue in the header: the consolidated text includes everything up to it. */
export function latestIssue(issues: string[]): string | null {
  return issues.length ? [...issues].sort(compareIssues)[issues.length - 1] : null;
}

/** The text from the first heading / article on, without the title page and header. */
export function bodyFrom(lines: string[]): string[] {
  const i = lines.findIndex(l => /^(?:Глава|ГЛАВА|Раздел|РАЗДЕЛ|Част|ЧАСТ|Дял|ДЯЛ)\s/u.test(l) || /^Чл\.\s*1\s*\./u.test(l));
  return i >= 0 ? lines.slice(i) : lines;
}
