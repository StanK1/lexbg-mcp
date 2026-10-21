import { describe, expect, it } from 'vitest';
import { htmlToLines } from '../src/text/html.js';
import { detectPart, extractParagraph, extractPoint, parseBulgarianAct } from '../src/text/parse-bg.js';
import { parseEuAct } from '../src/text/parse-eu.js';
import { extractEuReferences } from '../src/text/eu-refs.js';
import { formatCitation, parseCitation } from '../src/text/citation.js';
import { buildFtsQueries, buildTermGroups, coverage, stem, tokenize } from '../src/text/fts.js';
import { mentionsProvision } from '../src/text/mentions.js';

const LAW = `
<p>Глава първа</p><p>ОБЩИ ПОЛОЖЕНИЯ</p>
<p>Чл. 1. Този закон урежда примерни отношения.</p>
<p>Чл. 2. (1) Първа алинея.</p><p>(2) Втора алинея:</p><p>1. първа точка;</p><p>2. втора точка.</p>
<p>(3) Трета алинея.</p>
<p>Чл. 2а. Нов член.</p>
<p>Глава втора</p><p>ЗАДЪЛЖЕНИЯ</p>
<p>Чл. 3. Текст на чл. 3.</p>
<p>ДОПЪЛНИТЕЛНИ РАЗПОРЕДБИ</p>
<p>§ 1. По смисъла на този закон:</p><p>1. „Лице“ е всяко лице.</p><p>2. „Срок“ е срок.</p>
<p>ПРЕХОДНИ И ЗАКЛЮЧИТЕЛНИ РАЗПОРЕДБИ</p>
<p>§ 1. Законът влиза в сила от 1 януари.</p>
<p>§ 2. В Закона за счетоводството (обн., ДВ, бр. 95 от 2015 г.) се правят следните изменения:</p>
<p>1. В чл. 5 думата „левове“ се заменя с „евро“.</p>
`;

describe('parseBulgarianAct', () => {
  const provisions = parseBulgarianAct(htmlToLines(LAW));

  it('splits articles and keeps chapters', () => {
    const arts = provisions.filter(p => p.kind === 'art');
    expect(arts.map(a => a.num)).toEqual(['1', '2', '2а', '3']);
    expect(arts[0].chapter).toBe('Глава първа — ОБЩИ ПОЛОЖЕНИЯ');
    expect(arts[3].chapter).toBe('Глава втора — ЗАДЪЛЖЕНИЯ');
  });

  it('keeps § of the additional and transitional provisions apart (numbering restarts)', () => {
    const pars = provisions.filter(p => p.kind === 'par');
    expect(pars.map(p => p.label)).toEqual(['§ 1 ДР', '§ 1 ПЗР', '§ 2 ПЗР']);
    expect(pars[0].text).toContain('„Лице“');
    // the definitions must NOT be glued onto the last article
    expect(provisions.find(p => p.num === '3')!.text).not.toContain('По смисъла');
  });

  it('does not split amending acts on quoted new articles', () => {
    const amending = parseBulgarianAct([
      '§ 1. В чл. 5 се създава ал. 3:',
      '„(3) Нов текст.“',
      '§ 2. Създава се чл. 52б:',
      'Чл. 52б. (1) Предприятията ...',
      '§ 3. Последен параграф.',
    ]);
    expect(amending.map(p => p.label)).toEqual(['§ 1', '§ 2', '§ 3']);
    expect(amending[1].text).toContain('Чл. 52б. (1)');
  });

  it('splits "§ 114 ." labels written with a space before the dot', () => {
    const act = parseBulgarianAct([
      '§ 113. В Закона за X (обн., ДВ, бр. 1 от 2000 г.) думите „а“ се заменят с „б“.',
      '§ 114 . В Закона за счетоводството (обн., ДВ, бр. 95 от 2015 г.) в чл. 1 думите „в“ се заменят с „г“.',
    ]);
    expect(act.map(p => p.label)).toEqual(['§ 113', '§ 114']);
    expect(act[1].text.startsWith('§ 114 . В Закона за счетоводството')).toBe(true);
  });

  it('detects part headings strictly', () => {
    expect(detectPart('ДОПЪЛНИТЕЛНА РАЗПОРЕДБА')).toBe('dr');
    expect(detectPart('Преходни и заключителни разпоредби')).toBe('pzr');
    expect(detectPart('ПРЕХОДНИ И ЗАКЛЮЧИТЕЛНИ РАЗПОРЕДБИ към Закона за изменение и допълнение на Закона за счетоводството')).toBe('pzr');
    expect(detectPart('ЗАКЛЮЧИТЕЛНИ РАЗПОРЕДБИ')).toBe('zr');
    expect(detectPart('Преходните разпоредби се прилагат за всички договори.')).toBeNull();
  });

  it('extracts an алинея and a точка', () => {
    const art2 = provisions.find(p => p.num === '2')!;
    expect(extractParagraph(art2.text, '2')).toBe('(2) Втора алинея:\n1. първа точка;\n2. втора точка.');
    expect(extractPoint(extractParagraph(art2.text, '2')!, '2')).toBe('2. втора точка.');
    expect(extractParagraph(art2.text, '9')).toBeNull();
  });

  it('falls back to body chunks when there are no articles', () => {
    const out = parseBulgarianAct(['Някакъв текст без членове.', 'Още текст.']);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('body');
  });
});

describe('parseEuAct', () => {
  it('parses EUR-Lex style articles with titles', () => {
    const lines = ['ТЕСТОВ РЕГЛАМЕНТ', 'като взеха предвид ...', 'ГЛАВА I', 'Общи разпоредби', 'Член 1', 'Предмет', '1. Текст.', 'Член 2', 'Обхват', 'Текст две.', 'ПРИЛОЖЕНИЕ I', 'Таблица'];
    const out = parseEuAct(lines);
    expect(out.map(p => p.label)).toEqual(['Член 1', 'Член 2', 'Приложение I']);
    expect(out[0].text.startsWith('Член 1 — Предмет')).toBe(true);
    expect(out[0].chapter).toBe('ГЛАВА I — Общи разпоредби');
  });

  it('treats "Член N" lines inside annexes as annex text (no duplicate articles)', () => {
    const out = parseEuAct(['Член 1', 'Предмет', 'Текст.', 'ПРИЛОЖЕНИЕ', 'Таблица на съответствието', 'Член 1', 'Член 1 от Директива 95/46/ЕО']);
    expect(out.map(p => p.label)).toEqual(['Член 1', 'Приложение 1']);
    expect(out[1].text).toContain('Член 1 от Директива 95/46/ЕО');
  });
});

describe('extractEuReferences', () => {
  it('converts Bulgarian EU citations to CELEX', () => {
    const text = 'съгласно Регламент (ЕС) 2016/679, Директива (ЕС) 2015/849, Директива 2006/112/ЕО, Регламент (ЕО) № 1606/2002 и Регламент (ЕС) № 575/2013';
    expect(extractEuReferences(text).map(r => r.celex).sort()).toEqual(
      ['32002R1606', '32006L0112', '32013R0575', '32015L0849', '32016R0679'].sort(),
    );
  });
});

describe('mentionsProvision', () => {
  const own = ['Закона за счетоводството'];
  it('ignores an article number that belongs to another law', () => {
    const text = 'В Закона за счетоводството се правят изменения: 1. В чл. 38 ал. 9 ... такси по чл. 12, ал. 1, т. 1 от Закона за търговския регистър и регистъра на юридическите лица';
    expect(mentionsProvision(text, 'art', '12', own)).toBe(false);
    expect(mentionsProvision(text, 'art', '38', own)).toBe(true);
  });
  it('counts mentions of the law itself and of the transitional provisions', () => {
    expect(mentionsProvision('по чл. 12, ал. 2 от Закона за счетоводството', 'art', '12', own)).toBe(true);
    expect(mentionsProvision('съгласно чл. 12 от този закон', 'art', '12', own)).toBe(true);
    expect(mentionsProvision('В чл. 120 се правят изменения', 'art', '12', own)).toBe(false);
  });
});

describe('parseCitation', () => {
  it('reads article, алинея and точка', () => {
    expect(parseCitation('чл. 6, ал. 1, т. 2 от ЗЗЛД')).toMatchObject({ kind: 'art', num: '6', alineya: '1', point: '2', lawText: 'ЗЗЛД' });
    expect(parseCitation('чл.6а ал.2 ЗСч')).toMatchObject({ kind: 'art', num: '6а', alineya: '2', lawText: 'ЗСч' });
    expect(parseCitation('art. 6(1) GDPR')).toMatchObject({ kind: 'art', num: '6', alineya: '1', lawText: 'GDPR' });
  });

  it('reads § with its part', () => {
    expect(parseCitation('§ 1, т. 5 от ДР на ЗСч')).toMatchObject({ kind: 'par', num: '1', point: '5', part: 'dr', lawText: 'ЗСч' });
    expect(parseCitation('§ 3 от преходните и заключителните разпоредби на ЗДДС')).toMatchObject({ kind: 'par', part: 'pzr', lawText: 'ЗДДС' });
  });

  it('keeps the full law name', () => {
    expect(parseCitation('чл. 38 от Закона за счетоводството')!.lawText).toBe('Закона за счетоводството');
  });

  it('formats citations', () => {
    expect(formatCitation({ kind: 'art', num: '6', alineya: '1' }, 'ЗЗЛД')).toBe('чл. 6, ал. 1 ЗЗЛД');
    expect(formatCitation({ kind: 'par', num: '1', point: '5', part: 'dr' }, 'ЗСч')).toBe('§ 1, т. 5 от ДР на ЗСч');
  });

  it('rejects text without a provision', () => {
    expect(parseCitation('Закон за счетоводството')).toBeNull();
  });
});

describe('fts query building', () => {
  it('drops stopwords and stems Bulgarian words', () => {
    expect(tokenize('Какво трябва да съдържа данъчната фактура?')).toEqual(['съдържа', 'данъчната', 'фактура']);
    expect(stem('данъчната')).toBe('данъчн');
    expect(stem('задълженията')).toBe('задължен');
    expect(stem('финансовия')).toBe('финанс');
    expect(stem('дом')).toBe('дом');
  });

  it('does not over-strip short words into unrelated ones (платен ≠ платежна)', () => {
    expect(stem('платен')).toBe('платен');
    expect(coverage(buildTermGroups('платен'), 'платежна институция')).toBe(0);
    expect(stem('превалутират')).toBe('превалутир');
    expect(coverage(buildTermGroups('превалутират'), 'превалутирането от левове')).toBe(1);
  });

  it('bridges everyday words and legal vocabulary', () => {
    const groups = buildTermGroups('Мога ли да се откажа от покупка онлайн?');
    expect(coverage(groups, 'право на отказ от договор от разстояние')).toBe(1);
    expect(coverage(buildTermGroups('изкуствен интелект'), 'системи с ИИ')).toBe(1);
    expect(coverage(buildTermGroups('колко време'), 'в срок 5 години')).toBe(1);
  });

  it('builds strict and loose queries', () => {
    const q = buildFtsQueries('годишен финансов отчет');
    expect(q.strict).toBe('"годиш"* AND "финанс"* AND "отчет"*');
    expect(q.loose).toContain(' OR ');
    expect(buildFtsQueries('и на за').strict).toBeNull();
  });
});
