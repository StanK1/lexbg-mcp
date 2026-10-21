/**
 * A small, curated bridge between everyday words and the vocabulary of Bulgarian legislation.
 * People ask "мога ли да се откажа от покупка онлайн"; the law says "отказ от договор от разстояние".
 *
 * Keep this list short and general (no article numbers, no law-specific answers). Every entry
 * should help many questions; measure changes with `npm run eval`.
 */

export interface Variant {
  term: string;
  /** prefix match (term*) or whole word only */
  prefix: boolean;
}

const p = (term: string): Variant => ({ term, prefix: true });
const w = (term: string): Variant => ({ term, prefix: false });

const RULES: Array<[RegExp, Variant[]]> = [
  // abbreviations used in legal texts
  [/^изкуств/, [w('ии')]],
  [/^интелект/, [w('ии')]],
  [/^ддс$/, [p('добавен')]],
  [/^ес$/, [p('европейск')]],
  [/^нап$/, [p('приходит')]],
  [/^ксо$/, [p('осигуряван')]],
  // everyday → legal
  [/^онлайн$|^интернет$/, [p('разстояние'), p('електронн')]],
  [/^откаж|^отказв/, [p('отказ')]],
  [/^покупк|^купув|^купих/, [p('договор'), p('продажб')]],
  [/^фирм/, [p('дружеств'), p('търговец'), p('юридическ'), p('предприят')]],
  [/^компани/, [p('дружеств'), p('предприят')]],
  [/^служител/, [p('работни')]],
  [/^работни/, [p('служител')]],
  [/^шеф|^работодател/, [p('работодател')]],
  [/^заплат/, [p('възнагражден')]],
  [/^карта$|^картат|^карти/, [p('инструмент')]],
  [/^плащан|^плащ/, [p('платежн')]],
  [/^парит|^пари$/, [p('средств')]],
  [/^глоб/, [p('наказан'), p('санкци')]],
  [/^данн/, [p('информаци')]],
  [/^пазя|^пазен|^пазят/, [p('съхранява'), p('съхранен')]],
  [/^време$|^времето$/, [p('срок')]],
  [/^срок/, [p('срок')]],
  [/^изтрива|^изтрия/, [p('изтриван')]],
  [/^теч|^изтич/, [p('нарушени')]],
  [/^хакер|^атак/, [p('инцидент')]],
  [/^сигнал/, [p('сигнал'), p('съобщ')]],
];

export function synonymsFor(token: string): Variant[] {
  const out: Variant[] = [];
  for (const [re, variants] of RULES) {
    if (re.test(token)) out.push(...variants);
  }
  return out;
}
