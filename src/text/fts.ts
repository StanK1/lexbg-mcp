/**
 * Build SQLite FTS5 queries from free-text Bulgarian (or English) questions.
 *
 * SQLite has no Bulgarian stemmer, so we use a light suffix-stripping
 * "prefix stem": данъчно → данъчн*, задълженията → задължени*.
 */

const STOPWORDS = new Set([
  // Bulgarian function words
  'и', 'а', 'но', 'или', 'на', 'за', 'в', 'във', 'от', 'с', 'със', 'по', 'при', 'към', 'до', 'след', 'пред',
  'се', 'си', 'да', 'не', 'ли', 'е', 'са', 'съм', 'сме', 'сте', 'бъде', 'бъдат', 'има', 'няма',
  'как', 'какво', 'какви', 'каква', 'какъв', 'кой', 'коя', 'кое', 'кои', 'който', 'която', 'което', 'които',
  'кога', 'къде', 'защо', 'колко', 'дали', 'това', 'този', 'тази', 'тези', 'тоя', 'моя', 'мой', 'моята', 'ми', 'ме',
  'аз', 'ти', 'той', 'тя', 'то', 'ние', 'вие', 'те', 'нас', 'вас', 'им', 'го', 'я', 'ги',
  'трябва', 'може', 'могат', 'мога', 'искам', 'нужно', 'необходимо', 'ако', 'че', 'също', 'още', 'вече',
  'чл', 'ал', 'т', 'закон', 'закона', 'законът',
  // English
  'the', 'a', 'an', 'of', 'to', 'in', 'for', 'and', 'or', 'is', 'are', 'what', 'how', 'when', 'do', 'does', 'i', 'my',
]);

// Longest suffixes first.
const SUFFIXES = [
  'ностите', 'ността', 'ениета', 'ението', 'анията', 'ането', 'ията', 'ието', 'ите', 'ата', 'ото',
  'ски', 'ска', 'ско', 'ова', 'ови', 'ово', 'ия', 'ие', 'ът', 'ят', 'та', 'то', 'те', 'ен', 'на', 'но', 'ни', 'и', 'а', 'я', 'о', 'е', 'у', 'ю',
];

export function stem(word: string): string {
  const w = word.toLowerCase();
  if (w.length <= 4) return w;
  let out = w;
  for (const s of SUFFIXES) {
    if (out.endsWith(s) && out.length - s.length >= 4) {
      out = out.slice(0, -s.length);
      break;
    }
  }
  // Second pass for adjective stems: финансов(ия) → финанс, служебен → служеб.
  for (const s of ['ов', 'ев']) {
    if (out.endsWith(s) && out.length - s.length >= 5) return out.slice(0, -s.length);
  }
  return out;
}

export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[„“”"'«»]/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(t => t.length >= 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

export interface FtsQueries {
  /** All terms must match (higher precision). */
  strict: string | null;
  /** Any term may match (fallback, higher recall). */
  loose: string | null;
  terms: string[];
}

export function buildFtsQueries(query: string): FtsQueries {
  const tokens = [...new Set(tokenize(query))].slice(0, 12);
  const terms = tokens.map(t => {
    const s = stem(t);
    // Quote to neutralise FTS5 syntax; prefix-match the stem.
    return `"${s.replace(/"/g, '')}"*`;
  });
  if (terms.length === 0) return { strict: null, loose: null, terms: [] };
  return {
    strict: terms.join(' AND '),
    loose: terms.join(' OR '),
    terms: tokens,
  };
}
