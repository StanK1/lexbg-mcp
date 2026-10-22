/**
 * Compile the current text of a law: take the original text and apply every amending act
 * in State Gazette order, one instruction at a time. Each instruction is either applied,
 * skipped (it does not change this law's text, e.g. it amends another act's transitional
 * provisions) or failed (not understood / target not found) — failures are reported per
 * provision, never guessed.
 */
import {
  type Node, type ProvisionTree, cloneNode, compareNums, countLoose, looseRegex, normNum,
  parseFragment, parseProvision, serialize, walk,
} from './tree.js';
import {
  type Action, type Addr, type Op, type Scope, type WordOp, parseAmendmentChain, parseSection,
} from './instructions.js';
import { type InForce, resolveWhen, whenFor } from './in-force.js';

export type Part = 'main' | 'dr' | 'pzr' | 'pr' | 'zr';

export interface BaseProvision {
  kind: 'art' | 'par';
  num: string;
  part: Part;
  partKey: string;
  partTitle?: string;
  chapter?: string;
  glava?: string;
  text: string;
}

export interface AmendingAct {
  actId: number;
  title: string;
  adopted: string | null;
  stateGazette: string | null;
  mode: 'direct' | 'indirect' | 'repeal';
  /** The § units to apply, in order. */
  sections: Array<{ label: string; text: string }>;
  /** Entry-into-force rules from the act's final provisions. */
  inForce?: InForce;
}

export type ChangeStatus = 'applied' | 'skipped' | 'failed' | 'pending';

export interface ChangeRecord {
  /** Provision key "art|38|main"; '' when the instruction could not be tied to a provision. */
  key: string;
  actId: number;
  gazette: string;
  section: string;
  summary: string;
  status: ChangeStatus;
  note?: string;
  instruction: string;
  /** Date the instruction takes effect (estimated when it depends on the publication date). */
  inForce?: string;
  inForceEstimated?: boolean;
}

export interface CompiledProvision extends Omit<BaseProvision, 'text'> {
  text: string;
  changed: boolean;
  /** Gazette of the act that created this provision (undefined for original provisions). */
  createdBy?: string;
}

export interface CompileResult {
  provisions: CompiledProvision[];
  changes: ChangeRecord[];
  stats: { acts: number; applied: number; skipped: number; failed: number; pending: number };
  /** Gazette issues ("28/2020") listed as amendments in later acts but not in LexBG. */
  missingFromCatalogue: string[];
  /** Listed issues whose acts only mention the law (e.g. temporary rules), with no textual amendment. */
  mentionedOnly: Array<{ issue: string; acts: string[] }>;
  /** Latest gazette applied, e.g. "ДВ, бр. 67 от 2026 г." */
  through?: string;
}

interface WorkProv {
  kind: 'art' | 'par';
  num: string;
  part: Part;
  partKey: string;
  partTitle?: string;
  chapter?: string;
  glava?: string;
  tree: ProvisionTree;
  original: string;
  createdBy?: string;
}

class ApplyError extends Error {}

const KIND_BG: Record<string, [string, string]> = {
  art: ['чл.', 'Чл.'], par: ['§', '§'], al: ['ал.', 'ал.'], t: ['т.', 'т.'], b: ['буква', 'буква'], bb: ['буква', 'буква'],
  sent: ['изречение', 'изречение'], intro: ['текста преди', 'текста преди'],
};
const PREV_LABEL: Record<string, string> = { al: 'Предишна ал.', t: 'Предишна т.', b: 'Предишна буква', bb: 'Предишна буква', art: 'Предишен чл.', par: 'Предишен §' };

function gazetteKey(g: string | null): [number, number] {
  const m = g?.match(/бр\.\s*(\d+)\s*от\s*(\d{4})/u);
  return m ? [Number(m[2]), Number(m[1])] : [9999, 9999];
}

export function issueOf(g: string | null): string | null {
  const m = g?.match(/бр\.\s*(\d+)\s*от\s*(\d{4})/u);
  return m ? `${Number(m[1])}/${m[2]}` : null;
}

function addrLabel(path: Addr[]): string {
  return path.filter(a => a.kind !== 'intro').map(a => {
    const nums = a.kind === 'b' || a.kind === 'bb' ? a.nums.map(n => `„${n}“`) : a.nums;
    return `${KIND_BG[a.kind][0]} ${nums.join(', ')}`;
  }).join(', ');
}

// ------------------------------------------------------------------ sentences

const ABBREV = new Set(['чл', 'ал', 'т', 'бр', 'лв', 'изм', 'обн', 'доп', 'напр', 'вкл', 'др', 'ст', 'гр', 'ул', 'проф', 'д-р', 'стр', 'с', 'св', 'хил', 'млн', 'млрд', 'пар', 'рег', 'отм', 'попр']);

/** Sentence spans of a unit's text (Bulgarian legal text; abbreviations like "чл." do not end a sentence). */
export function sentenceSpans(s: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let start = 0;
  const re = /[.!?]["“”»)]?\s+(?=[А-ЯA-Z„(])/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const before = s.slice(start, m.index);
    const word = before.match(/([\p{L}-]+)$/u)?.[1]?.toLowerCase();
    if (word && (ABBREV.has(word) || word.length === 1)) continue;
    const end = m.index + m[0].trimEnd().length;
    spans.push([start, end]);
    start = m.index + m[0].length;
  }
  if (start < s.length) spans.push([start, s.length]);
  return spans;
}

// ------------------------------------------------------------------ text edits

function tidy(s: string): string {
  return s.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;:)])/g, '$1').replace(/\(\s+/g, '(').replace(/,\s*,/g, ',').trim();
}

function needsSpaceBefore(text: string): boolean {
  return !/^[,.;:)]/u.test(text);
}

/** Apply one word-level edit to a string. Returns null when the anchor text is not there. */
export function editText(s: string, op: WordOp, all: boolean): string | null {
  switch (op.op) {
    case 'replace': {
      const re = op.commaBefore ? new RegExp(`,\\s*${looseRegex(op.from).source}`, 'gu') : looseRegex(op.from);
      if (!re.test(s)) return null;
      re.lastIndex = 0;
      let done = false;
      const out = s.replace(re, m => {
        if (done && !all) return m;
        done = true;
        return op.commaBefore ? (op.to ? `, ${op.to}` : '') : op.to;
      });
      return tidy(out);
    }
    case 'delete': {
      let src = looseRegex(op.text).source;
      if (op.commaBefore) src = `,\\s*${src}`;
      if (op.commaAfter) src = `${src}\\s*,`;
      const re = new RegExp(src, 'gu');
      if (!re.test(s)) return null;
      re.lastIndex = 0;
      let done = false;
      return tidy(s.replace(re, m => { if (done && !all) return m; done = true; return ''; }));
    }
    case 'insertAfter': {
      const re = looseRegex(op.anchor);
      const m = re.exec(s);
      if (!m) return null;
      const at = m.index + m[0].length;
      const ins = op.sep
        ? `${op.sep}${op.text}`
        : `${op.commaBefore ? ',' : ''}${needsSpaceBefore(op.text) ? ' ' : ''}${op.text}${op.commaAfter && !/,$/u.test(op.text) ? ',' : ''}`;
      return tidy(s.slice(0, at) + ins + s.slice(at));
    }
    case 'punctAfter': {
      const m = looseRegex(op.anchor).exec(s);
      if (!m) return null;
      const at = m.index + m[0].length;
      if (s.slice(at).trimStart().startsWith(op.punct)) return s;
      return tidy(s.slice(0, at) + op.punct + s.slice(at));
    }
    case 'insertBefore': {
      const m = looseRegex(op.anchor).exec(s);
      if (!m) return null;
      return tidy(`${s.slice(0, m.index)}${op.text} ${s.slice(m.index)}`);
    }
    case 'append': {
      const t = s.trimEnd();
      const p = t.match(/[.;:,]$/u);
      const base = p ? t.slice(0, -1) : t;
      const sep = !base ? '' : `${op.comma ? ',' : ''}${needsSpaceBefore(op.text) ? ' ' : ''}`;
      return tidy(`${base}${sep}${op.text}${p ? p[0] : ''}`);
    }
    case 'truncateAfter': {
      const m = looseRegex(op.anchor).exec(s);
      if (!m) return null;
      return `${s.slice(0, m.index + m[0].length)}.`;
    }
    case 'replaceAfter': {
      const re = looseRegex(op.anchor);
      let m: RegExpExecArray | null;
      while ((m = re.exec(s))) {
        const at = m.index + m[0].length;
        const after = s.slice(at);
        const fromSrc = op.from === ',' ? ',' : op.from === ';' ? ';' : looseRegex(op.from).source;
        const f = after.match(new RegExp(`^\\s*${fromSrc}`, 'u'));
        if (!f) continue;
        const rep = op.to === ',' || op.to === ';' ? op.to : ` ${op.to}`;
        return tidy(s.slice(0, at) + rep + after.slice(f[0].length));
      }
      return null;
    }
    case 'prepend':
      return tidy(`${op.text} ${s}`);
    case 'appendLine':
      return null;
  }
}

function anchorOf(op: WordOp): string | null {
  switch (op.op) {
    case 'replace': return op.from;
    case 'delete': return op.text;
    case 'insertAfter':
    case 'punctAfter':
    case 'insertBefore':
    case 'truncateAfter':
    case 'replaceAfter': return op.anchor;
    case 'append':
    case 'prepend':
    case 'appendLine': return null;
  }
}

function markKind(op: WordOp): 'Изм.' | 'Доп.' {
  return op.op === 'replace' || op.op === 'delete' || op.op === 'truncateAfter' || op.op === 'replaceAfter' ? 'Изм.' : 'Доп.';
}

// ------------------------------------------------------------------ the compiler

export class LawCompiler {
  private provs: WorkProv[];
  readonly changes: ChangeRecord[] = [];
  private act!: AmendingAct;
  private gazette = '';
  private section = '';
  private touched = new Set<Node>();

  constructor(base: BaseProvision[], private readonly lawGenitives: string[]) {
    this.provs = base.map(p => ({
      kind: p.kind, num: normNum(p.num), part: p.part, partKey: p.partKey, partTitle: p.partTitle,
      chapter: p.chapter, glava: p.glava, tree: parseProvision(p.text), original: p.text,
    }));
  }

  private mark(type: string): string {
    const d = this.inForce?.date && !this.inForce.estimated ? this.inForce.date.match(/^(\d{4})-(\d{2})-(\d{2})$/u) : null;
    return `${type} – ${this.gazette}${d ? `, в сила от ${Number(d[3])}.${d[2]}.${d[1]} г.` : ''}`;
  }

  private record(key: string, summary: string, status: ChangeStatus, op: Op, note?: string): void {
    const extra = this.inForce?.note && status === 'applied' ? this.inForce.note : undefined;
    this.changes.push({
      key, actId: this.act.actId, gazette: this.gazette, section: this.section, summary, status,
      note: [note, extra].filter(Boolean).join(' ') || undefined,
      instruction: op.source.length > 1200 ? `${op.source.slice(0, 1200)} …` : op.source,
      inForce: this.inForce?.date ?? undefined,
      inForceEstimated: this.inForce?.date ? this.inForce.estimated : undefined,
    });
  }

  private inForce?: { date: string | null; estimated: boolean; note?: string };

  /** Apply the instructions of one § (or of some of its items) of an amending act. */
  applyUnit(act: AmendingAct, section: string, ops: Op[], inForce?: { date: string | null; estimated: boolean; note?: string }): void {
    this.act = act;
    this.gazette = act.stateGazette ?? `act ${act.actId}`;
    this.section = section;
    this.inForce = inForce;
    for (const op of ops) this.applyOp(op);
    this.finishSection();
  }

  /** Instructions that take effect in the future are listed, not applied. */
  recordPending(act: AmendingAct, section: string, ops: Op[], inForce: { date: string | null; estimated: boolean }): void {
    this.act = act;
    this.gazette = act.stateGazette ?? `act ${act.actId}`;
    this.section = section;
    this.inForce = inForce;
    for (const op of ops) {
      if (op.action.type === 'noop' && op.action.why === 'container') continue;
      if (op.scope.otherAct) continue;
      const where = addrLabel(op.scope.path) || 'law';
      this.record(this.keyFor(op.scope), `takes effect ${inForce.date ?? 'later'} (${where})`, 'pending', op, `Not applied yet: in force from ${inForce.date}${inForce.estimated ? ' (estimated)' : ''}.`);
    }
  }

  recordParseFailure(act: AmendingAct, section: string, text: string, err: Error): void {
    this.changes.push({ key: '', actId: act.actId, gazette: act.stateGazette ?? '', section, summary: 'section', status: 'failed', note: `could not parse: ${err.message}`, instruction: text.slice(0, 1200) });
  }

  private finishSection(): void {
    for (const n of this.touched) sortChildren(n);
    for (const p of this.provs) for (const n of walk(p.tree.root)) delete n.fresh;
    this.touched.clear();
  }

  // ---------------------------------------------------------------- dispatch

  private applyOp(op: Op): void {
    const { scope, action } = op;
    const key = this.keyFor(scope);
    const where = addrLabel(scope.path) || (scope.glava ? `глава ${scope.glava}` : '') || (scope.part && scope.part !== 'main' ? scope.part.toUpperCase() : 'law');
    if (action.type === 'noop') {
      if (action.why !== 'container') this.record(key, `${action.why} (${where})`, 'skipped', op);
      return;
    }
    if (scope.otherAct) {
      this.record('', `amends ${scope.otherAct}`, 'skipped', op, 'Changes another act (e.g. the transitional provisions of an earlier amending act), not the text of this law.');
      return;
    }
    if (action.type === 'unknown') {
      this.record(key, `not understood (${where})`, 'failed', op, action.why);
      return;
    }
    try {
      if (scope.headingTarget && !(action.type === 'create')) {
        const note = this.applyHeading(scope, action);
        this.record(key, `heading (${where})`, note ? 'skipped' : 'applied', op, note ?? undefined);
        return;
      }
      if (scope.lawWide && action.type === 'words') {
        this.record('', this.applyLawWide(action.ops), 'applied', op);
        return;
      }
      if (action.type === 'renumber' && (action.from.kind === 'art' || action.from.kind === 'par') && !scope.path.some(a => a.kind === 'art' || a.kind === 'par')) {
        this.record(key, this.renumberProvisions(scope, action), 'applied', op);
        return;
      }
      if (action.type === 'create' && (action.what.kind === 'art' || action.what.kind === 'par') && scope.path.length === 0) {
        const keys = this.createProvisions(scope, action);
        this.record(keys[0] ?? '', `added ${KIND_BG[action.what.kind][0]} ${action.what.nums.join(', ')}`, 'applied', op);
        return;
      }
      const summary = this.applyInProvision(scope, action);
      this.record(key, summary, 'applied', op);
    } catch (err) {
      if (err instanceof ApplyError) this.record(key, `${action.type} (${where})`, 'failed', op, err.message);
      else throw err;
    }
  }

  private keyFor(scope: Scope): string {
    const first = scope.path[0];
    if (!first || (first.kind !== 'art' && first.kind !== 'par')) return '';
    const p = this.findProv(first.kind, first.nums[0], scope.part);
    return p ? provKey(p) : `${first.kind}|${normNum(first.nums[0])}|${first.kind === 'art' ? 'main' : scope.part ?? 'dr'}`;
  }

  private findProv(kind: 'art' | 'par', num: string, part?: string): WorkProv | undefined {
    const n = normNum(num);
    const cands = this.provs.filter(p => p.kind === kind && p.num === n && (kind === 'art' ? p.part === 'main' : !part || p.part === part));
    if (cands.length <= 1) return cands[0];
    // several § N in different parts and no part named: prefer the additional provisions (definitions)
    return cands.find(p => p.part === 'dr') ?? cands[0];
  }

  // ---------------------------------------------------------------- provisions

  /** "Навсякъде в закона думите „X“ се заменят с „Y“" — every provision of the law. */
  private applyLawWide(ops: WordOp[]): string {
    let hits = 0;
    for (const p of this.provs) {
      for (const n of walk(p.tree.root)) {
        for (const op of ops) {
          const anchor = anchorOf(op);
          if (!anchor || !countLoose(n.body, anchor)) continue;
          const out = editText(n.body, op, true);
          if (out === null) continue;
          n.body = out;
          hits++;
          const m = this.mark(n.kind === 'al' || n.kind === 'root' ? markKind(op) : markKind(op).toLowerCase());
          if (!n.marks.includes(m)) n.marks.push(m);
        }
      }
    }
    if (!hits) throw new ApplyError('the words to change were not found anywhere in the law');
    return `changed wording throughout the law (${hits} place(s))`;
  }

  /** "Досегашният чл. 9в става чл. 9б" */
  private renumberProvisions(scope: Scope, action: Extract<Action, { type: 'renumber' }>): string {
    const kind = action.from.kind as 'art' | 'par';
    const to = action.to.nums.map(normNum);
    if (to.length !== action.from.nums.length) throw new ApplyError('renumbering lists do not match');
    const moved = action.from.nums.map(num => {
      const cands = this.provs.filter(p => p.kind === kind && p.num === normNum(num) && (kind === 'art' ? p.part === 'main' : !scope.part || p.part === scope.part));
      const p = cands.find(c => !c.createdBy || c.createdBy !== this.gazette) ?? cands[0];
      if (!p) throw new ApplyError(`${KIND_BG[kind][1]} ${num} not found`);
      return p;
    });
    moved.forEach((p, i) => {
      const old = p.num;
      p.num = to[i];
      p.tree.root.num = to[i];
      p.tree.root.marks.push(`${PREV_LABEL[kind]} ${old} – ${this.gazette}`);
      // keep the provisions of the part in numeric order
      this.provs.splice(this.provs.indexOf(p), 1);
      this.provs.splice(this.insertIndex(kind, p.part, p.num), 0, p);
    });
    let summary = `renumbered ${KIND_BG[kind][0]} ${action.from.nums.join(', ')} → ${to.join(', ')}`;
    if (action.then) {
      for (const p of moved) summary += `; ${this.applyToProvision(p, { ...scope, path: [{ kind, nums: [p.num] }, ...(action.thenPath ?? [])] }, action.then)}`;
    }
    return summary;
  }

  private createProvisions(scope: Scope, action: Extract<Action, { type: 'create' }>): string[] {
    const kind = action.what.kind as 'art' | 'par';
    const text = action.quotes.join('\n');
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const startRe = kind === 'art' ? /^Чл\.\s*(\d+[а-яa-z]*)\s*\./u : /^§\s*(\d+[а-яa-z]*)\s*\./u;
    const headings: string[] = [];
    const units: Array<{ num: string; lines: string[] }> = [];
    for (const l of lines) {
      const m = l.match(startRe);
      if (m) units.push({ num: normNum(m[1]), lines: [l] });
      else if (units.length) units[units.length - 1].lines.push(l);
      else headings.push(l);
    }
    if (!units.length) throw new ApplyError('no provision found in the new text');
    const part: Part = kind === 'art' ? 'main' : (scope.part ?? 'dr');
    let chapter: string | undefined;
    if (action.razdel || headings.length) {
      // "Раздел VII" / "ДЯЛ ЧЕТВЪРТИ" + its title line
      const isHead = (x: string) => /^(?:раздел|глава|дял|част|отдел)\s/iu.test(x);
      const head = headings.find(isHead) ?? (action.razdel ? (/\s/u.test(action.razdel) ? action.razdel : `Раздел ${action.razdel}`) : undefined);
      const title = headings.find(x => !isHead(x));
      if (head) chapter = `${head.charAt(0).toUpperCase()}${head.slice(1)}${title ? ` — ${title}` : ''}`;
    }
    const keys: string[] = [];
    for (const u of units) {
      const existing = this.findProv(kind, u.num, part);
      if (existing && !existing.tree.root.marks.some(m => /^Отм/u.test(m))) throw new ApplyError(`${KIND_BG[kind][1]} ${u.num} already exists`);
      const idx = this.insertIndex(kind, part, u.num);
      const prev = this.provs[idx - 1];
      const sameScope = prev && prev.part === part;
      const tree = parseProvision(u.lines.join('\n'));
      tree.root.marks.push(this.mark(kind === 'art' ? 'Нов' : 'Нов'));
      const wp: WorkProv = {
        kind, num: u.num, part,
        partKey: sameScope ? prev.partKey : part,
        partTitle: sameScope ? prev.partTitle : undefined,
        chapter: chapter ?? (sameScope ? prev.chapter : undefined),
        glava: sameScope ? prev.glava : undefined,
        tree, original: '', createdBy: this.gazette,
      };
      if (existing) this.provs.splice(this.provs.indexOf(existing), 1, wp);
      else this.provs.splice(idx, 0, wp);
      keys.push(provKey(wp));
    }
    return keys;
  }

  private insertIndex(kind: 'art' | 'par', part: Part, num: string): number {
    let idx = -1;
    let lastOfPart = -1;
    this.provs.forEach((p, i) => {
      if (p.part !== part || p.kind !== kind) return;
      lastOfPart = i;
      if (compareNums(p.num, num) < 0) idx = i;
    });
    if (idx >= 0) return idx + 1;
    if (lastOfPart >= 0) return this.provs.findIndex(p => p.part === part && p.kind === kind);
    // first provision of a part that does not exist yet: append at the end
    return this.provs.length;
  }

  // ---------------------------------------------------------------- inside a provision

  private applyInProvision(scope: Scope, action: Action): string {
    const first = scope.path[0];
    if (!first || (first.kind !== 'art' && first.kind !== 'par')) throw new ApplyError('no article or § named');
    const results: string[] = [];
    for (const num of first.nums) {
      const prov = this.findProv(first.kind, num, scope.part);
      if (!prov) throw new ApplyError(`${KIND_BG[first.kind][1]} ${num} not found`);
      results.push(this.applyToProvision(prov, scope, action));
    }
    return results.join('; ');
  }

  private applyToProvision(prov: WorkProv, scope: Scope, action: Action): string {
    const rest = scope.path.slice(1);
    const label = `${KIND_BG[prov.kind][1]} ${prov.num}`;
    // whole provision
    if (!rest.length) {
      switch (action.type) {
        case 'replace': {
          // laws with article titles quote the title first ("Пречки за …\nЧл. 9. …"): keep the article only
          const lines = action.quotes.join('\n').split('\n');
          const start = lines.findIndex(l => /^(?:Чл\.|§)\s*\d+[а-яa-z]*\s*\./u.test(l.trim()));
          const tree = parseProvision(lines.slice(Math.max(start, 0)).join('\n'));
          if (tree.root.num && tree.root.num !== prov.num) throw new ApplyError(`new text is for ${tree.root.num}, expected ${prov.num}`);
          tree.root.num = prov.num;
          tree.head = prov.kind;
          tree.root.marks = [...prov.tree.root.marks.filter(m => !/^Отм/u.test(m)), this.mark('Изм.')];
          prov.tree = tree;
          return `replaced ${label}`;
        }
        case 'repeal':
          prov.tree.root = { kind: 'root', num: prov.num, body: '', marks: [...prov.tree.root.marks, this.mark('Отм.')], children: [] };
          return `repealed ${label}`;
        default:
          return `${this.applyToNodes(prov, [prov.tree.root], [], scope, action, label)}`;
      }
    }
    const { nodes, sentence, introOnly } = this.resolve(prov.tree.root, rest, action);
    return this.applyToNodes(prov, nodes, rest, scope, action, `${label}, ${addrLabel(rest)}`, sentence, introOnly);
  }

  /** Find the nodes an address points to. The last address level may name several units. */
  private resolve(root: Node, path: Addr[], action: Action): { nodes: Node[]; sentence?: number[]; introOnly: boolean } {
    let current: Node[] = [root];
    let sentence: number[] | undefined;
    let introOnly = false;
    const prev = action.type === 'renumber';
    for (let i = 0; i < path.length; i++) {
      const a = path[i];
      const isLast = i === path.length - 1;
      if (a.kind === 'intro') { introOnly = true; continue; }
      if (a.kind === 'sent') { sentence = a.nums.map(Number); continue; }
      // the created / renumbered unit is named by the action itself, not by the path
      if (isLast && action.type === 'create' && action.what.kind === a.kind && sameNums(action.what.nums, a.nums)) break;
      const next: Node[] = [];
      for (const n of current) {
        for (const num of a.nums) {
          const found = findChild(n, a.kind, normNum(num), prev && isLast);
          if (!found) throw new ApplyError(`${KIND_BG[a.kind][1]} ${num} not found`);
          next.push(found);
        }
      }
      current = next;
    }
    return { nodes: current, sentence, introOnly };
  }

  private applyToNodes(prov: WorkProv, nodes: Node[], path: Addr[], scope: Scope, action: Action, where: string, sentence?: number[], introOnly = false): string {
    switch (action.type) {
      case 'replace': {
        if (sentence) {
          for (const n of nodes) this.replaceSentences(n, sentence, action.quotes);
          return `amended ${where}`;
        }
        if (introOnly) {
          // "текстът преди т. 1 се изменя така: „…“"
          for (const n of nodes) {
            n.body = action.quotes[0].trim();
            n.marks.push(this.mark(n.kind === 'al' || n.kind === 'root' ? 'Изм.' : 'изм.'));
          }
          return `amended the text before the points in ${where}`;
        }
        const frags = parseFragment(action.quotes.join('\n'));
        const target = path[path.length - 1];
        if (frags.length !== nodes.length) throw new ApplyError(`${nodes.length} unit(s) to replace but the new text has ${frags.length}`);
        nodes.forEach((n, i) => {
          const f = frags[i];
          if (target && f.kind !== n.kind && !(f.kind === 'text' && n.kind === 'root')) throw new ApplyError(`new text is a ${f.kind}, expected ${n.kind}`);
          if (n.kind !== 'root' && f.num && f.num !== n.num) throw new ApplyError(`new text is numbered ${f.num}, expected ${n.num}`);
          n.body = f.body;
          n.children = f.children;
          n.repealed = false;
          n.marks = [...n.marks.filter(m => !/^Отм/u.test(m)), this.mark(n.kind === 'al' || n.kind === 'root' ? 'Изм.' : 'изм.')];
        });
        return `amended ${where}`;
      }
      case 'repeal': {
        if (sentence) {
          for (const n of nodes) this.replaceSentences(n, sentence, sentence.map(() => ''));
          return `repealed ${where}`;
        }
        for (const n of nodes) {
          n.body = '';
          n.children = [];
          n.repealed = true;
          n.marks = [...n.marks, this.mark(n.kind === 'al' ? 'Отм.' : 'отм.')];
        }
        return `repealed ${where}`;
      }
      case 'create': {
        const what = action.what;
        if (what.kind === 'sent') {
          for (const n of nodes) {
            const spans = sentenceSpans(n.body);
            const texts = spans.map(([a, b]) => n.body.slice(a, b));
            const at = Math.min(Number(what.nums[0]) - 1, texts.length);
            texts.splice(at, 0, ...action.quotes);
            n.body = texts.join(' ');
            n.marks.push(this.mark(n.kind === 'al' || n.kind === 'root' ? 'Доп.' : 'доп.'));
          }
          return `added ${KIND_BG.sent[0]} ${what.nums.join(', ')} in ${where}`;
        }
        if (what.kind === 'art' || what.kind === 'par') throw new ApplyError('cannot create a provision inside a provision');
        const frags = parseFragment(action.quotes.join('\n'));
        const want = what.nums.map(normNum);
        if (frags.length !== want.length || frags.some((f, i) => f.kind !== what.kind || f.num !== want[i])) {
          throw new ApplyError(`new text does not match ${KIND_BG[what.kind][1]} ${what.nums.join(', ')}`);
        }
        if (nodes.length !== 1) throw new ApplyError('ambiguous place for the new unit');
        const parent = nodes[0];
        for (const f of frags) {
          const clash = parent.children.find(c => c.kind === f.kind && c.num === f.num && !c.fresh);
          if (clash && !action.isNew && !clash.repealed) throw new ApplyError(`${KIND_BG[f.kind][1]} ${f.num} already exists`);
          f.fresh = true;
          f.marks.push(this.mark(f.kind === 'al' ? 'Нова' : 'нова'));
          insertChild(parent, f);
          // a unit added after the last one: the previous last unit now ends with ";" instead of "."
          const same = parent.children.filter(c => c.kind === f.kind);
          if (f.kind !== 'al' && same[same.length - 1] === f && same.length > 1) {
            const prev = same[same.length - 2];
            if (/[^.]\.$/u.test(prev.body) && !prev.children.length && /[.;]$/u.test(f.body)) prev.body = `${prev.body.slice(0, -1)};`;
          }
          if (clash && clash.repealed && !action.isNew) parent.children.splice(parent.children.indexOf(clash), 1);
        }
        this.touched.add(parent);
        return `added ${KIND_BG[what.kind][0]} ${what.nums.join(', ')}${where ? ` in ${where}` : ''}`;
      }
      case 'renumber': {
        const to = action.to.nums.map(normNum);
        const from = action.from;
        const parents = nodes;
        const moved: Node[] = [];
        for (const parent of parents) {
          from.nums.forEach((num, i) => {
            const n = findChild(parent, from.kind, normNum(num), true);
            if (!n) throw new ApplyError(`${KIND_BG[from.kind][1]} ${num} not found`);
            moved.push(n);
            if (to[i] === undefined) throw new ApplyError('renumbering lists do not match');
          });
        }
        moved.forEach((n, i) => {
          const old = n.num;
          n.num = to[i % to.length];
          n.marks.push(`${PREV_LABEL[n.kind] ?? 'Предишен'} ${old} – ${this.gazette}`);
          n.fresh = true; // later "досегашната …" in the same § must not pick it again
        });
        for (const p of parents) this.touched.add(p);
        let summary = `renumbered ${KIND_BG[from.kind][0]} ${from.nums.join(', ')} → ${to.join(', ')}`;
        if (action.then) {
          const label = `${where}, ${KIND_BG[from.kind][0]} ${to.join(', ')}`;
          if (action.thenPath?.length) {
            for (const n of moved) {
              const r = this.resolve(n, action.thenPath, action.then);
              summary += `; ${this.applyToNodes(prov, r.nodes, [...path, { kind: from.kind, nums: to }, ...action.thenPath], scope, action.then, `${label}, ${addrLabel(action.thenPath)}`, r.sentence, r.introOnly)}`;
            }
          } else {
            summary += `; ${this.applyToNodes(prov, moved, [...path, { kind: from.kind, nums: to }], scope, action.then, label)}`;
          }
        }
        return summary;
      }
      case 'wrap': {
        for (const n of nodes) {
          const al: Node = {
            kind: action.into.kind === 't' ? 't' : 'al', num: '1', body: n.body, marks: [],
            children: n.children,
          };
          al.marks.push(`Предишен текст на ${prov.kind === 'art' ? `чл. ${prov.num}` : `§ ${prov.num}`} – ${this.gazette}`);
          n.body = '';
          n.children = [al];
        }
        return `former text becomes ${KIND_BG[action.into.kind][0]} 1 (${where})`;
      }
      case 'words':
        return this.applyWords(nodes, action.ops, scope.everywhere ?? false, where, sentence, introOnly);
      default:
        throw new ApplyError(`unsupported action ${action.type}`);
    }
  }

  private replaceSentences(n: Node, nums: number[], texts: string[]): void {
    const spans = sentenceSpans(n.body);
    const parts = spans.map(([a, b]) => n.body.slice(a, b));
    nums.forEach((k, i) => {
      if (k < 1 || k > parts.length) throw new ApplyError(`sentence ${k} not found (${parts.length} sentence(s))`);
      parts[k - 1] = texts[i] ?? texts[0];
    });
    n.body = parts.filter(Boolean).join(' ');
    n.marks.push(this.mark(n.kind === 'al' || n.kind === 'root' ? 'Изм.' : 'изм.'));
  }

  private applyWords(nodes: Node[], ops: WordOp[], everywhere: boolean, where: string, sentence?: number[], introOnly = false): string {
    for (const target of nodes) {
      for (const op of ops) {
        const anchor = anchorOf(op);
        const mk = markKind(op);
        if (op.op === 'appendLine') {
          target.children.push({ kind: 'text', num: '', body: op.text, marks: [], children: [] });
          const m = this.mark(target.kind === 'al' || target.kind === 'root' ? 'Доп.' : 'доп.');
          if (!target.marks.includes(m)) target.marks.push(m);
          continue;
        }
        // a short word ("и", "му") replaced or deleted without a place: must be unique
        if (!everywhere && anchor && anchor.trim().length <= 3 && (op.op === 'replace' || op.op === 'delete')) {
          const where2 = sentence ? (() => { const sp = sentenceSpans(target.body)[sentence[0] - 1]; return sp ? target.body.slice(sp[0], sp[1]) : ''; })() : target.body;
          const n = countLoose(where2, anchor);
          if (n > 1) throw new ApplyError(`„${anchor}“ appears ${n} times in ${where}; the instruction does not say which`);
        }
        const markFor = (n: Node) => {
          const m = this.mark(n.kind === 'al' || n.kind === 'root' ? mk : mk.toLowerCase());
          if (!n.marks.includes(m)) n.marks.push(m);
        };
        if (everywhere) {
          let hits = 0;
          for (const n of walk(target)) {
            if (!anchor || !countLoose(n.body, anchor)) continue;
            const out = editText(n.body, op, true);
            if (out !== null) { n.body = out; hits++; markFor(n); }
          }
          if (!hits) throw new ApplyError(`„${anchor}“ not found in ${where}`);
          continue;
        }
        if (sentence) {
          const spans = sentenceSpans(target.body);
          const k = sentence[0];
          if (k < 1 || k > spans.length) throw new ApplyError(`sentence ${k} not found`);
          const [a, b] = spans[k - 1];
          const out = editText(target.body.slice(a, b), op, false);
          if (out === null) throw new ApplyError(`„${anchor}“ not found in sentence ${k} of ${where}`);
          target.body = tidy(target.body.slice(0, a) + out + target.body.slice(b));
          markFor(target);
          continue;
        }
        if (!anchor || countLoose(target.body, anchor) || introOnly) {
          const out = editText(target.body, op, true);
          if (out === null) throw new ApplyError(`„${anchor}“ not found in ${where}`);
          target.body = out;
          markFor(target);
          continue;
        }
        // the words are in a sub-unit (drafting sometimes names only the article or алинея)
        const holders = walk(target).filter(n => n !== target && countLoose(n.body, anchor));
        if (holders.length !== 1) {
          throw new ApplyError(holders.length ? `„${anchor}“ appears in ${holders.length} units of ${where}` : `„${anchor}“ not found in ${where}`);
        }
        const out = editText(holders[0].body, op, true);
        if (out === null) throw new ApplyError(`„${anchor}“ not found in ${where}`);
        holders[0].body = out;
        markFor(holders[0]);
      }
    }
    return `${ops.map(o => (markKind(o) === 'Изм.' ? 'amended' : 'supplemented')).filter((v, i, a) => a.indexOf(v) === i).join(' and ')} wording in ${where}`;
  }

  // ---------------------------------------------------------------- headings

  /** Returns a note when the heading change could not be placed (it does not affect provision text). */
  private applyHeading(scope: Scope, action: Action): string | null {
    if (scope.headingTarget === 'title') return 'headings and article titles are not tracked separately';
    if (scope.headingTarget === 'annex') return 'annexes are not part of the stored provision texts';
    const glavaRe = scope.glava ? new RegExp(`^глава\\s+${scope.glava}(?![\\p{L}])`, 'iu') : null;
    const razdelRe = scope.razdel ? new RegExp(`^раздел\\s+${scope.razdel.replace(/[а-я]$/u, m => `[${m}${m === 'а' ? 'a' : ''}]`)}(?![\\p{L}IVX])`, 'iu') : null;
    const newTitle = (old: string): string | null => {
      const [head, title = ''] = old.split(' — ');
      if (action.type === 'replace') return `${head} — ${action.quotes[0]}`;
      if (action.type === 'words') {
        let t = title;
        for (const op of action.ops) {
          const upper = title && title === title.toUpperCase();
          const o = upper && 'text' in op ? { ...op, text: op.text.toUpperCase() } : upper && op.op === 'replace' ? { ...op, from: op.from.toUpperCase(), to: op.to.toUpperCase() } : op;
          const r = editText(t, o as WordOp, false);
          if (r === null) return null;
          t = r;
        }
        return `${head} — ${t}`;
      }
      return null;
    };
    let hits = 0;
    if (scope.headingTarget === 'glava' && glavaRe) {
      for (const p of this.provs) {
        for (const field of ['glava', 'chapter'] as const) {
          const v = p[field];
          if (v && glavaRe.test(v)) {
            const n = newTitle(v);
            if (n) { p[field] = n; hits++; }
          }
        }
      }
      return hits ? null : `heading of глава ${scope.glava} not found`;
    }
    if (scope.headingTarget === 'razdel' && razdelRe) {
      const inGlava = (p: WorkProv) => !glavaRe || (p.glava ? glavaRe.test(p.glava) : false);
      const cands = this.provs.filter(p => p.chapter && razdelRe.test(p.chapter));
      const scoped = cands.filter(inGlava);
      const pick = scoped.length ? scoped : new Set(cands.map(p => p.chapter)).size === 1 ? cands : [];
      for (const p of pick) {
        const n = newTitle(p.chapter!);
        if (n) { p.chapter = n; hits++; }
      }
      return hits ? null : `heading of раздел ${scope.razdel}${scope.glava ? ` in глава ${scope.glava}` : ''} not found`;
    }
    return 'heading change not understood';
  }

  // ---------------------------------------------------------------- output

  result(): CompiledProvision[] {
    return this.provs.map(p => {
      const text = serialize(p.tree);
      return {
        kind: p.kind, num: p.num, part: p.part, partKey: p.partKey, partTitle: p.partTitle,
        chapter: p.chapter, glava: p.glava, text, changed: text !== p.original, createdBy: p.createdBy,
      };
    });
  }
}

function sameNums(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => normNum(x) === normNum(b[i]));
}

export function provKey(p: { kind: string; num: string; part: string }): string {
  return `${p.kind}|${p.num}|${p.part}`;
}

function findChild(n: Node, kind: string, num: string, previous: boolean): Node | undefined {
  const cands = n.children.filter(c => c.kind === kind && c.num === num);
  if (cands.length <= 1) return cands[0];
  const old = cands.filter(c => !c.fresh);
  if (previous) return old[0] ?? cands[0];
  return old.find(c => !c.repealed) ?? old[0] ?? cands[0];
}

function insertChild(parent: Node, f: Node): void {
  const kids = parent.children;
  let idx = -1;
  kids.forEach((c, i) => { if (c.kind === f.kind && compareNums(c.num, f.num) < 0) idx = i; });
  if (idx >= 0) {
    // skip past the units nested under that sibling (they are its children, not siblings)
    kids.splice(idx + 1, 0, f);
    return;
  }
  const firstSame = kids.findIndex(c => c.kind === f.kind);
  if (firstSame >= 0) { kids.splice(firstSame, 0, f); return; }
  let lastNumbered = -1;
  kids.forEach((c, i) => { if (c.kind !== 'text') lastNumbered = i; });
  kids.splice(lastNumbered + 1, 0, f);
}

/** Put numbered units back in numeric order after renumbering; plain lines keep their slots. */
function sortChildren(n: Node): void {
  const slots: number[] = [];
  const units: Node[] = [];
  n.children.forEach((c, i) => { if (c.kind !== 'text') { slots.push(i); units.push(c); } });
  const sorted = [...units].sort((a, b) => (a.kind === b.kind ? compareNums(a.num, b.num) : 0));
  slots.forEach((s, i) => { n.children[s] = sorted[i]; });
}

// ------------------------------------------------------------------ entry point

export interface CompileOptions {
  /** ISO date: amendments taking effect after it are listed as pending. Default: today. */
  today?: string;
  /** The base text already includes every amendment up to this gazette issue ("72/2024"). */
  coveredUpTo?: string;
  /** Titles of acts in that gazette issue ("28/2020") that mention the law without amending its text. */
  mentions?: (issue: string) => string[];
}

export function compileLaw(base: BaseProvision[], acts: AmendingAct[], lawGenitives: string[], opts: CompileOptions = {}): CompileResult {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const ordered = [...acts].filter(a => a.mode !== 'repeal').sort((a, b) => {
    const [ya, ia] = gazetteKey(a.stateGazette);
    const [yb, ib] = gazetteKey(b.stateGazette);
    return ya - yb || ia - ib || (a.adopted ?? '').localeCompare(b.adopted ?? '') || a.actId - b.actId;
  });
  const c = new LawCompiler(base.map(p => ({ ...p, text: p.text })), lawGenitives);

  // Split every § into groups that take effect together, then apply them in order of
  // entry into force (an act adopted earlier can take effect later, e.g. the euro changeover).
  interface Unit { act: AmendingAct; order: number; section: string; ops: Op[]; date: string | null; estimated: boolean; note?: string }
  const units: Unit[] = [];
  ordered.forEach((act, ai) => {
    act.sections.forEach((s, si) => {
      let ops: Op[];
      try {
        ops = parseSection(s.text, lawGenitives);
      } catch (err) {
        c.recordParseFailure(act, s.label, s.text, err as Error);
        return;
      }
      const par = s.label.match(/§\s*(\d+[а-я]?)/u)?.[1] ?? null;
      const groups = new Map<string, Op[]>();
      for (const op of ops) {
        const w = whenFor(act.inForce, par, op.item);
        const k = JSON.stringify(w);
        groups.set(k, [...(groups.get(k) ?? []), op]);
      }
      for (const [k, g] of groups) {
        const r = resolveWhen(JSON.parse(k), act.adopted);
        units.push({ act, order: ai * 10000 + si, section: s.label, ops: g, date: r.date, estimated: r.estimated, note: r.note });
      }
    });
  });
  units.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.order - b.order);
  let through: string | undefined;
  for (const u of units) {
    if (u.date && u.date > today) c.recordPending(u.act, u.section, u.ops, { date: u.date, estimated: u.estimated });
    else {
      c.applyUnit(u.act, u.section, u.ops, { date: u.date, estimated: u.estimated, note: u.note });
      through = u.act.stateGazette ?? through;
    }
  }
  const changes = c.changes;
  const count = (s: ChangeStatus) => changes.filter(x => x.status === s).length;

  // Completeness: later amending acts list every earlier amendment in "(обн., ДВ …; изм., бр. …)".
  const ours = new Set(acts.map(a => issueOf(a.stateGazette)).filter(Boolean) as string[]);
  const chains: Array<{ at: [number, number]; issues: string[] }> = [];
  for (const a of ordered) {
    for (const s of a.sections) {
      const ch = parseAmendmentChain(s.text);
      if (ch?.amended.length) chains.push({ at: gazetteKey(a.stateGazette), issues: ch.amended });
    }
  }
  const missing: string[] = [];
  const latest = chains[chains.length - 1];
  if (latest) {
    const covered = opts.coveredUpTo?.split('/').map(Number);
    for (const iss of latest.issues) {
      if (ours.has(iss)) continue;
      const [n, y] = iss.split('/').map(Number);
      if (covered && (y < covered[1] || (y === covered[1] && n <= covered[0]))) continue;
      const later = chains.filter(ch => ch.at[0] > y || (ch.at[0] === y && ch.at[1] > n));
      const votes = later.filter(ch => ch.issues.includes(iss)).length;
      if (later.length <= 1 || votes * 2 >= later.length) missing.push(iss);
    }
  }
  return {
    provisions: c.result(),
    changes,
    stats: { acts: ordered.length, applied: count('applied'), skipped: count('skipped'), failed: count('failed'), pending: count('pending') },
    missingFromCatalogue: missing.filter(m => !(opts.mentions?.(m).length)),
    mentionedOnly: missing.map(m => ({ issue: m, acts: opts.mentions?.(m) ?? [] })).filter(x => x.acts.length),
    through: latestGazette(ordered.map(a => a.stateGazette).filter((g): g is string => Boolean(g) && changes.some(ch => ch.gazette === g && ch.status === 'applied'))) ?? through,
  };
}

function latestGazette(gs: string[]): string | undefined {
  return [...gs].sort((a, b) => {
    const [ya, ia] = gazetteKey(a);
    const [yb, ib] = gazetteKey(b);
    return ya - yb || ia - ib;
  }).pop();
}

export { cloneNode };
