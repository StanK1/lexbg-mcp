/**
 * Link promulgated acts to the laws they amend.
 *
 * Bulgarian laws are amended in two ways, and most tools only catch the first:
 *   direct   — an act titled "Закон за изменение и допълнение на Закона за X"
 *   indirect — a § inside ANOTHER act: "§ 12. В Закона за X (обн., ДВ, бр. ...) се правят
 *              следните изменения ..." (very common in budget laws and new codes)
 */
import type { LawEntry } from './registry.js';

const AMENDING_PREFIX = /^Закон\s+за\s+(?:изменение\s+и\s+допълнение|изменения\s+и\s+допълнения|изменение|допълнение)\s+на\s+/u;
const REPEAL_PREFIX = /^Закон\s+за\s+(?:отменяне|отмяна)\s+на\s+/u;

export function isAmendingTitle(title: string): boolean {
  return AMENDING_PREFIX.test(title.trim());
}

export function isRepealTitle(title: string): boolean {
  return REPEAL_PREFIX.test(title.trim());
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
}

function genitivesOf(law: LawEntry): string[] {
  return [law.genitive, ...(law.genitives ?? [])].sort((a, b) => b.length - a.length);
}

/** Longest-match wins so "Закона за търговския регистър и регистъра на ЮЛНЦ" beats shorter names. */
function bestMatch(text: string, laws: LawEntry[], build: (g: string) => RegExp): LawEntry | null {
  let best: { law: LawEntry; len: number } | null = null;
  for (const law of laws) {
    for (const g of genitivesOf(law)) {
      if (build(g).test(text) && (!best || g.length > best.len)) best = { law, len: g.length };
    }
  }
  return best?.law ?? null;
}

const after = '(?![\\p{L}])';

export function directTarget(title: string, laws: LawEntry[]): LawEntry | null {
  const t = title.trim();
  if (!isAmendingTitle(t)) return null;
  const rest = t.replace(AMENDING_PREFIX, '');
  return bestMatch(rest, laws, g => new RegExp(`^${escapeRe(g)}${after}`, 'u'));
}

export function repealTarget(title: string, laws: LawEntry[]): LawEntry | null {
  const t = title.trim();
  if (!isRepealTitle(t)) return null;
  const rest = t.replace(REPEAL_PREFIX, '');
  return bestMatch(rest, laws, g => new RegExp(`^${escapeRe(g)}${after}`, 'u'));
}

/**
 * Does this section (§ / Чл.) of an act amend one of the tracked laws?
 *   "§ 12. В Закона за счетоводството (обн., ДВ ...) се правят следните изменения:"
 *   "§ 3. В чл. 5, ал. 1 от Закона за счетоводството (обн., ДВ ...) думите ..."
 */
export function indirectTarget(sectionText: string, laws: LawEntry[]): LawEntry | null {
  const firstLine = sectionText.split('\n')[0].slice(0, 600);
  const lead = '^(?:§|Чл\\.)\\s*\\d+[а-я]?\\.\\s*(?:\\(\\d+\\)\\s*)?В\\s+(?:[^;()]{0,120}?\\s+от\\s+)?';
  return bestMatch(firstLine, laws, g => new RegExp(`${lead}${escapeRe(g)}${after}\\s*[(,]`, 'u'));
}

/** Exact original title of a tracked law (the act that enacted it). */
export function baseTitleMatch(title: string, laws: LawEntry[]): LawEntry | null {
  const t = title.trim().replace(/\s+/g, ' ');
  for (const law of laws) {
    const titles = [law.title, ...(law.base_titles ?? [])];
    if (titles.some(x => x === t)) return law;
  }
  return null;
}

/** True if the act is relevant to any tracked law by title alone (used for --only-tracked downloads). */
export function titleIsTracked(title: string, laws: LawEntry[]): boolean {
  return Boolean(baseTitleMatch(title, laws) || directTarget(title, laws) || repealTarget(title, laws));
}
