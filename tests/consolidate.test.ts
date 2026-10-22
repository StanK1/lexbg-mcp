import { describe, expect, it } from 'vitest';
import { parseProvision, serialize, looseRegex } from '../src/consolidate/tree.js';
import { expandNums, parseAmendmentChain, parseSection } from '../src/consolidate/instructions.js';
import { compileLaw, editText, sentenceSpans, type AmendingAct, type BaseProvision } from '../src/consolidate/apply.js';
import { parseInForce, whenFor } from '../src/consolidate/in-force.js';

const G = ['Закона за счетоводството'];

const BASE: BaseProvision[] = [
  { kind: 'art', num: '1', part: 'main', partKey: 'main', chapter: 'Глава първа — ОБЩИ ПОЛОЖЕНИЯ', text:
    'Чл. 1. Този закон урежда:\n1. изискванията към счетоводството;\n2. приложимата счетоводна база;\n3. съдържанието на финансовите отчети, докладите за дейността и докладите за плащанията;\n4. задълженията за независим финансов одит;\n5. задълженията на ръководителя.' },
  { kind: 'art', num: '19', part: 'main', partKey: 'main', chapter: 'Раздел I — Категории предприятия', text:
    'Чл. 19. (1) Категории предприятия:\n1. микропредприятия;\n2. малки предприятия.\n(2) Микропредприятия са предприятия, които не надвишават два от показателите:\n1. балансова стойност на активите – 700 000 лв.;\n2. нетни приходи от продажби – 1 400 000 лв.;\n3. средна численост на персонала – 10 души.' },
  { kind: 'art', num: '37', part: 'main', partKey: 'main', chapter: 'Глава пета — НЕЗАВИСИМ ФИНАНСОВ ОДИТ', text:
    'Чл. 37. (1) На одит подлежат отчетите на:\n1. малки предприятия, които надвишават два от показателите:\na) балансова стойност на активите – 2 000 000 лв.;\nб) нетни приходи от продажби – 4 000 000 лв.;\n2. средните предприятия.\n(2) Акционерните дружества подлежат на одит.\n(3) Консолидираните отчети подлежат на одит.' },
  { kind: 'art', num: '39', part: 'main', partKey: 'main', chapter: 'Глава седма — ДОКЛАДИ', text: 'Чл. 39. Докладът за дейността съдържа преглед на развитието.' },
  { kind: 'art', num: '43', part: 'main', partKey: 'main', chapter: 'Глава седма — ДОКЛАДИ', text: 'Чл. 43. Стар текст, който ще бъде отменен.' },
  { kind: 'par', num: '1', part: 'dr', partKey: 'dr', text: '§ 1. По смисъла на този закон:\n1. „Бюджетни предприятия“ са Българската академия на науките и други.\n2. „Група“ е предприятие майка и дъщерните му предприятия.' },
];

function act(id: number, gazette: string, adopted: string, sections: string[], inForce?: string): AmendingAct {
  return {
    actId: id, title: `Закон ${id}`, adopted, stateGazette: gazette, mode: 'indirect',
    sections: sections.map((text, i) => ({ label: `§ ${text.match(/^§\s*(\d+[а-я]?)/u)?.[1] ?? i + 1}`, text })),
    inForce: inForce ? parseInForce([inForce]) : undefined,
  };
}

describe('provision tree', () => {
  it('round-trips an article with алинеи, точки and букви', () => {
    const t = parseProvision(BASE[2].text);
    expect(t.root.children.map(c => c.num)).toEqual(['1', '2', '3']);
    expect(t.root.children[0].children[0].children.map(c => c.num)).toEqual(['а', 'б']);
    expect(serialize(t)).toBe(BASE[2].text.replace('\na)', '\nа)'));
  });

  it('matches quoted phrases loosely (spaces, dashes, look-alike letters)', () => {
    expect(looseRegex('ал. 3 - 5').test('по ал. 3 – 5 се')).toBe(true);
    expect(looseRegex('буква a').test('буква а')).toBe(true);
    expect(looseRegex('лв').test('левове')).toBe(false);
  });

  it('splits sentences without breaking at "чл." or "ал."', () => {
    const s = 'Първо изречение по чл. 5, ал. 2. Второ изречение. Трето.';
    expect(sentenceSpans(s).map(([a, b]) => s.slice(a, b))).toEqual(['Първо изречение по чл. 5, ал. 2.', 'Второ изречение.', 'Трето.']);
  });
});

describe('instruction parser', () => {
  it('reads nested items with scopes', () => {
    const ops = parseSection('§ 4. В Закона за счетоводството (обн., ДВ, бр. 95 от 2015 г.) в чл. 19 се правят следните изменения:\n1. В ал. 2 т. 1 и 2 се изменят така:\n„1. балансова стойност на активите – 900 000 лв.;\n2. нетни приходи от продажби – 1 800 000 лв.;“.', G);
    expect(ops).toHaveLength(1);
    expect(ops[0].scope.path).toEqual([{ kind: 'art', nums: ['19'] }, { kind: 'al', nums: ['2'] }, { kind: 't', nums: ['1', '2'] }]);
    expect(ops[0].action.type).toBe('replace');
    expect(ops[0].item).toBe('1');
  });

  it('reads renumbering with a follow-up change', () => {
    const [op] = parseSection('§ 1. В чл. 1 се правят следните изменения:\n1. Досегашната т. 3 става т. 4 и в нея след думите „докладите за дейността“ се поставя запетая и се добавя „включително отчитането на устойчивостта,“.', G);
    expect(op.action).toMatchObject({ type: 'renumber', from: { kind: 't', nums: ['3'] }, to: { kind: 't', nums: ['4'] }, then: { type: 'words' } });
  });

  it('splits several word changes in one sentence', () => {
    const [op] = parseSection('§ 8. В чл. 57, ал. 1 думата „трети“ се заменя с „третите“, а след думата „страни“ се поставя запетая и думите „по силата на закон“ се заменят с „включени в приложение“.', G);
    expect(op.action.type === 'words' && op.action.ops.map(o => o.op)).toEqual(['replace', 'punctAfter', 'replace']);
  });

  it('marks changes to another act as such', () => {
    const [op] = parseSection('§ 1. В § 30, ал. 1 от преходните и заключителните разпоредби на Закона за изменение и допълнение на Закона за счетоводството (ДВ, бр. 72 от 2024 г.) думите „2024 г.“ се заменят с „2025 г.“.', G);
    expect(op.scope.otherAct).toMatch(/^Закона за изменение/);
  });

  it('expands number lists and ranges', () => {
    expect(expandNums('1, 2, 3 и 6')).toEqual(['1', '2', '3', '6']);
    expect(expandNums('35 – 38')).toEqual(['35', '36', '37', '38']);
    expect(expandNums('62а – чл. 62в')).toEqual(['62а', '62б', '62в']);
  });

  it('reads the amendment chain of a law', () => {
    expect(parseAmendmentChain('§ 1. В Закона за счетоводството (обн., ДВ, бр. 95 от 2015 г.; изм., бр. 74, 95 и 97 от 2016 г. и бр. 13 от 2019 г.) …'))
      .toEqual({ published: '95/2015', amended: ['74/2016', '95/2016', '97/2016', '13/2019'] });
  });
});

describe('word edits', () => {
  it('appends before the final punctuation', () => {
    expect(editText('1. търговците;', { op: 'append', text: 'включително клоновете', comma: true }, false)).toBe('1. търговците, включително клоновете;');
  });
  it('deletes words with the comma before them', () => {
    expect(editText('лице, извършено с цел подкуп, в срок', { op: 'delete', text: 'извършено с цел подкуп', commaBefore: true }, false)).toBe('лице, в срок');
  });
});

describe('entry into force', () => {
  it('reads general dates and exceptions', () => {
    const inf = parseInForce(['§ 9. Законът влиза в сила от 1 януари 2024 г. с изключение на:\n1. параграфи 2, 3, § 6, т. 1 и § 8, които влизат в сила от 1 януари 2025 г.;\n2. параграф 7, който влиза в сила от 22 декември 2023 г.\nЗаконът е приет от 49-ото Народно събрание']);
    expect(whenFor(inf, '4')).toEqual({ kind: 'date', date: '2024-01-01' });
    expect(whenFor(inf, '6', '1')).toEqual({ kind: 'date', date: '2025-01-01' });
    expect(whenFor(inf, '6', '2')).toEqual({ kind: 'date', date: '2024-01-01' });
    expect(whenFor(inf, '7')).toEqual({ kind: 'date', date: '2023-12-22' });
  });
  it('knows the euro changeover date', () => {
    const inf = parseInForce(['§ 60. Параграф 5, ал. 1, § 8 – 36 и § 38 – 59 влизат в сила от датата, определена в Решение на Съвета на Европейския съюз за приемането на еврото от Република България.']);
    expect(whenFor(inf, '43')).toEqual({ kind: 'date', date: '2026-01-01' });
    expect(whenFor(inf, '37')).toEqual({ kind: 'publication', days: 3 });
  });
});

describe('compileLaw', () => {
  const acts: AmendingAct[] = [
    // adopted first, but takes effect last (euro changeover)
    act(1, 'ДВ, бр. 70 от 2024 г.', '2024-08-07', [
      '§ 43. В Закона за счетоводството (обн., ДВ, бр. 95 от 2015 г.) в чл. 19, ал. 2 т. 1 и 2 се изменят така:\n„1. балансова стойност на активите – 450 000 евро;\n2. нетни приходи от продажби – 900 000 евро;“',
    ], '§ 60. Параграф 43 влиза в сила от датата на въвеждане на еврото в Република България.'),
    act(2, 'ДВ, бр. 72 от 2024 г.', '2024-08-14', [
      '§ 1. В Закона за счетоводството (обн., ДВ, бр. 95 от 2015 г.) в чл. 1 се правят следните изменения:\n1. Създава се нова т. 3:\n„3. приложимата рамка за отчитане на устойчивостта;“.\n2. Досегашната т. 3 става т. 4 и в нея след думите „докладите за дейността“ се поставя запетая и се добавя „включително отчитането на устойчивостта,“.\n3. Досегашните т. 4 и 5 стават съответно т. 5 и 6.',
      '§ 2. В Закона за счетоводството (обн., ДВ, бр. 95 от 2015 г.) се правят следните изменения:\n1. В чл. 19, ал. 2 т. 1 и 2 се изменят така:\n„1. балансова стойност на активите – 900 000 лв.;\n2. нетни приходи от продажби – 1 800 000 лв.;“.\n2. В чл. 37:\nа) в ал. 1, т. 1, буква „а“ числото „2 000 000“ се заменя с „4 000 000“;\nб) алинея 2 се отменя.\n3. В чл. 39 се правят следните допълнения:\nа) досегашният текст става ал. 1;\nб) създава се ал. 2:\n„(2) Големите предприятия включват и нематериални ресурси.“\n4. Член 43 се отменя.\n5. Създава се чл. 43а:\n„Чл. 43а. Нов член.“\n6. В § 1, т. 1 от допълнителните разпоредби след думите „Българската академия на науките“ се поставя запетая и се добавя „Селскостопанската академия“.\n7. В чл. 99 думите „нещо“ се заменят с „друго“.',
    ], '§ 42. Законът влиза в сила от деня на обнародването му в „Държавен вестник“.'),
    act(3, 'ДВ, бр. 10 от 2099 г.', '2099-01-01', [
      '§ 1. В Закона за счетоводството (обн., ДВ, бр. 95 от 2015 г.) в чл. 37, ал. 3 думите „подлежат на одит“ се заменят с „подлежат на проверка“.',
    ]),
  ];
  const r = compileLaw(BASE, acts, G, { today: '2026-10-22' });
  const text = (kind: string, num: string) => r.provisions.find(p => p.kind === kind && p.num === num)?.text;

  it('applies changes in order of entry into force', () => {
    expect(text('art', '19')).toContain('1. (изм. – ДВ, бр. 72 от 2024 г., бр. 70 от 2024 г., в сила от 1.01.2026 г.) балансова стойност на активите – 450 000 евро;');
  });

  it('inserts, renumbers and edits units', () => {
    expect(text('art', '1')).toBe([
      'Чл. 1. Този закон урежда:',
      '1. изискванията към счетоводството;',
      '2. приложимата счетоводна база;',
      '3. (нова – ДВ, бр. 72 от 2024 г.) приложимата рамка за отчитане на устойчивостта;',
      '4. (предишна т. 3 – ДВ, бр. 72 от 2024 г., доп. – ДВ, бр. 72 от 2024 г.) съдържанието на финансовите отчети, докладите за дейността, включително отчитането на устойчивостта, и докладите за плащанията;',
      '5. (предишна т. 4 – ДВ, бр. 72 от 2024 г.) задълженията за независим финансов одит;',
      '6. (предишна т. 5 – ДВ, бр. 72 от 2024 г.) задълженията на ръководителя.',
    ].join('\n'));
  });

  it('repeals units and articles, keeping their numbers', () => {
    expect(text('art', '37')).toContain('(2) (Отм. – ДВ, бр. 72 от 2024 г.)');
    expect(text('art', '37')).toContain('а) (изм. – ДВ, бр. 72 от 2024 г.) балансова стойност на активите – 4 000 000 лв.;');
    expect(text('art', '43')).toBe('Чл. 43. (Отм. – ДВ, бр. 72 от 2024 г.)');
  });

  it('wraps a former text into ал. 1 and adds new articles in order', () => {
    expect(text('art', '39')).toBe('Чл. 39. (1) (Предишен текст на чл. 39 – ДВ, бр. 72 от 2024 г.) Докладът за дейността съдържа преглед на развитието.\n(2) (Нова – ДВ, бр. 72 от 2024 г.) Големите предприятия включват и нематериални ресурси.');
    const order = r.provisions.filter(p => p.kind === 'art').map(p => p.num);
    expect(order).toEqual(['1', '19', '37', '39', '43', '43а']);
    expect(r.provisions.find(p => p.num === '43а')?.chapter).toBe('Глава седма — ДОКЛАДИ');
  });

  it('amends the additional provisions', () => {
    expect(text('par', '1')).toContain('Българската академия на науките, Селскостопанската академия и други.');
  });

  it('reports what it could not apply and what takes effect later', () => {
    const failed = r.changes.filter(c => c.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].note).toMatch(/чл\. 99 not found/i);
    const pending = r.changes.filter(c => c.status === 'pending');
    expect(pending).toHaveLength(1);
    expect(text('art', '37')).toContain('подлежат на одит');
  });
});

describe('consolidated texts from institutions', async () => {
  const { reflowLines, headerIssues, latestIssue, bodyFrom } = await import('../src/text/consolidated.js');
  it('re-flows wrapped PDF lines into units', () => {
    const lines = reflowLines([
      'ЗАКОН ЗА СЧЕТОВОДСТВОТО', 'Раздел I', 'Приложно поле', 'Чл. 1. Този закон', 'урежда:',
      '1. изискванията към', 'счетоводството, най-', 'малко два показателя;', '12', 'а) и/', 'или нещо.',
    ]);
    expect(lines).toEqual(['ЗАКОН ЗА СЧЕТОВОДСТВОТО', 'Раздел I', 'Приложно поле', 'Чл. 1. Този закон урежда:',
      '1. изискванията към счетоводството, най-малко два показателя;', 'а) и/или нещо.']);
    expect(bodyFrom(lines)[0]).toBe('Раздел I');
  });
  it('reads the last State Gazette issue from the header', () => {
    const issues = headerIssues('Обн. ДВ. бр.95 от 8 Декември 2015г., изм. ДВ. бр.74 от\n20 Септември 2016г., изм. и доп., бр. 13 от 12.02.2019 г.\nЧл. 1. Текст (изм. – ДВ, бр. 99 от 2099 г.)');
    expect(issues).toEqual(['95/2015', '74/2016', '13/2019']);
    expect(latestIssue(issues)).toBe('13/2019');
  });
});
