/**
 * When do the §§ of an amending act take effect?
 *
 *   "Законът влиза в сила от 1 януари 2024 г. с изключение на: 1. параграфи 2, 3, 5, § 6, т. 1
 *    и § 8, които влизат в сила от 1 януари 2025 г.; 2. параграф 7, който влиза в сила от
 *    22 декември 2023 г."
 *   "§ 60. Параграф 5, ал. 1, § 8 – 36, § 37, т. 1 – 12 и 14 – 20 и § 38 – 59 влизат в сила от
 *    датата, определена в Решение на Съвета на Европейския съюз за приемането на еврото …"
 *
 * Without a clause, a law takes effect three days after publication (Constitution, art. 5(5)).
 */

/** Bulgaria adopted the euro on 1 January 2026. */
export const EURO_DATE = '2026-01-01';

export type When =
  | { kind: 'date'; date: string }
  | { kind: 'publication'; days: number }
  | { kind: 'unknown'; text: string };

export interface InForceRule {
  par: string;
  /** Level-1 items of the § ("§ 6, т. 1"); undefined = the whole §. */
  items?: string[];
  when: When;
}

export interface InForce {
  general: When;
  rules: InForceRule[];
  /** The clause(s) as written, for display. */
  text?: string;
}

const MONTHS: Record<string, string> = {
  януари: '01', февруари: '02', март: '03', април: '04', май: '05', юни: '06',
  юли: '07', август: '08', септември: '09', октомври: '10', ноември: '11', декември: '12',
};

export function parseWhen(phrase: string): When {
  const p = phrase.replace(/\s+/g, ' ').trim();
  let m: RegExpMatchArray | null;
  if ((m = p.match(/^от\s+(\d{1,2})\s+(януари|февруари|март|април|май|юни|юли|август|септември|октомври|ноември|декември)\s+(\d{4})\s*г/iu))) {
    return { kind: 'date', date: `${m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}` };
  }
  if ((m = p.match(/^от\s+(\d{1,2})\.(\d{1,2})\.(\d{4})/u))) {
    return { kind: 'date', date: `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` };
  }
  if (/^от\s+(?:деня|датата)\s+на\s+обнародването/iu.test(p)) return { kind: 'publication', days: 0 };
  if ((m = p.match(/^(\d+|един|два|три|четири|пет|седем|десет|четиринадесет|тридесет)\s+дни\s+след\s+обнародването/iu))) {
    const words: Record<string, number> = { един: 1, два: 2, три: 3, четири: 4, пет: 5, седем: 7, десет: 10, четиринадесет: 14, тридесет: 30 };
    return { kind: 'publication', days: Number(m[1]) || words[m[1].toLowerCase()] || 3 };
  }
  if (/еврото/iu.test(p) && /(?:въвеждане|приемането)/iu.test(p)) return { kind: 'date', date: EURO_DATE };
  return { kind: 'unknown', text: p.slice(0, 200) };
}

const DATE_PHRASE = String.raw`((?:от|\d+\s+дни|три\s+дни|един\s+месец)[^;]*?)(?=;|\.\s|\.$|\s+с\s+изключение|$)`;

/** "параграфи 2, 3, 5, § 6, т. 1 и § 8" → [{par:2},{par:3},{par:5},{par:6,items:[1]},{par:8}] */
export function parseRefs(s: string): Array<{ par: string; items?: string[] }> {
  const out: Array<{ par: string; items?: string[] }> = [];
  const tokens = s.replace(/\s+/g, ' ').replace(/[–-]/g, ' – ').split(/\s*(?:,|\sи\s)\s*/u);
  let last: { par: string; items?: string[] } | null = null;
  let mode: 'par' | 'item' | 'al' = 'par';
  for (let tok of tokens) {
    tok = tok.trim();
    if (!tok) continue;
    let m: RegExpMatchArray | null;
    if ((m = tok.match(/^(?:§|параграф(?:и)?)\s*(.*)$/iu))) { mode = 'par'; tok = m[1]; }
    else if ((m = tok.match(/^т\.\s*(.*)$/u))) { mode = 'item'; tok = m[1]; }
    else if ((m = tok.match(/^ал\.\s*(.*)$/u))) { mode = 'al'; tok = m[1]; }
    const r = tok.match(/^(\d+[а-я]?)(?:\s*–\s*(\d+[а-я]?))?$/u);
    if (!r) continue;
    const nums: string[] = [];
    if (r[2] && /^\d+$/.test(r[1]) && /^\d+$/.test(r[2])) for (let i = Number(r[1]); i <= Number(r[2]) && i - Number(r[1]) < 500; i++) nums.push(String(i));
    else nums.push(r[1]);
    if (mode === 'par') {
      for (const n of nums) { last = { par: n }; out.push(last); }
    } else if (mode === 'item' && last) {
      last.items = [...(last.items ?? []), ...nums];
    }
    // "ал." of a non-amending § does not change which amendments apply: ignore
  }
  return out;
}

/** Find the entry-into-force rules in the text of an act (all its sections). */
export function parseInForce(sections: string[]): InForce {
  const result: InForce = { general: { kind: 'publication', days: 3 }, rules: [] };
  const clauses: string[] = [];
  for (const raw of sections) {
    const text = raw.replace(/\s+/g, ' ');
    if (!/влиза(?:т)?\s+в\s+сила/u.test(text)) continue;
    // "Законът влиза в сила …" with optional exceptions
    const gen = text.match(/(?:Законът|Този\s+закон|Кодексът|Този\s+кодекс)\s+влиза\s+в\s+сила\s+(.*?)(?=Законът\s+е\s+приет|$)/u);
    if (gen) {
      clauses.push(gen[0].trim());
      const body = gen[1];
      const head = body.split(/\s+с\s+изключение\s+на/u)[0];
      result.general = parseWhen(head);
      const exc = body.match(/с\s+изключение\s+на\s*:?\s*(.*)$/u);
      if (exc) result.rules.push(...parseExceptions(exc[1]));
      continue;
    }
    // "§ 60. Параграф 5, ал. 1, § 8 – 36 … влизат в сила от …"
    const re = new RegExp(String.raw`((?:Параграф|Параграфи|§)\s*(?:[^.]|\.(?=\s*\d))*?)\s+влиза(?:т)?\s+в\s+сила\s+${DATE_PHRASE}`, 'gu');
    for (const m of text.matchAll(re)) {
      const refsText = m[1].replace(/^§\s*\d+[а-я]?\s*\.\s*/u, '');
      const refs = parseRefs(refsText);
      if (!refs.length) continue;
      clauses.push(m[0].trim());
      const when = parseWhen(m[2]);
      for (const r of refs) result.rules.push({ ...r, when });
    }
  }
  if (clauses.length) result.text = clauses.join(' ').slice(0, 1500);
  return result;
}

function parseExceptions(s: string): InForceRule[] {
  const rules: InForceRule[] = [];
  const re = new RegExp(String.raw`(?:^|;|\d+\.)\s*((?:§|параграф|параграфи|Параграф|Параграфи)[^;]*?),?\s+(?:които|който)\s+влиза(?:т)?\s+в\s+сила\s+${DATE_PHRASE}`, 'gu');
  for (const m of s.matchAll(re)) {
    const when = parseWhen(m[2]);
    for (const r of parseRefs(m[1])) rules.push({ ...r, when });
  }
  return rules;
}

/** Rule for one § (and item) of the act. */
export function whenFor(inf: InForce | undefined, par: string | null, item?: string): When {
  if (!inf) return { kind: 'publication', days: 3 };
  if (par) {
    const n = par.toLowerCase();
    const withItem = item ? inf.rules.find(r => r.par === n && r.items?.includes(item)) : undefined;
    if (withItem) return withItem.when;
    const whole = inf.rules.find(r => r.par === n && !r.items);
    if (whole) return whole.when;
  }
  return inf.general;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Resolve to a date. Publication dates are not in the parliament.bg data, so they are
 * estimated as adoption + 7 days (laws are promulgated within 15 days of adoption).
 */
export function resolveWhen(when: When, adopted: string | null): { date: string | null; estimated: boolean; note?: string } {
  if (when.kind === 'date') return { date: when.date, estimated: false };
  if (!adopted) return { date: null, estimated: true };
  if (when.kind === 'publication') return { date: addDays(adopted, 7 + when.days), estimated: true };
  return { date: addDays(adopted, 10), estimated: true, note: `entry into force: ${when.text}` };
}
