import { describe, expect, it } from 'vitest';
import { loadRegistry, resolveEu, resolveLaw, resolveTopic } from '../src/registry.js';
import { directTarget, indirectTarget, isAmendingTitle, repealTarget } from '../src/amendments.js';

const reg = loadRegistry();

describe('registry', () => {
  it('loads and cross-validates the YAML files', () => {
    expect(reg.laws.length).toBeGreaterThan(30);
    expect(reg.eu.length).toBeGreaterThan(10);
    expect(reg.topics.length).toBeGreaterThan(15);
    expect(new Set(reg.laws.map(l => l.id)).size).toBe(reg.laws.length);
  });

  it('topic packs contain no article numbers (those must come from the texts)', () => {
    for (const t of reg.topics) {
      for (const s of [t.summary, ...t.queries, ...t.questions]) {
        expect(s, `${t.id}: "${s}"`).not.toMatch(/(?<!\p{L})(чл\.|§)\s*\d/u);
      }
    }
  });

  it('resolves laws by abbreviation, id, title, genitive and alias', () => {
    expect(resolveLaw(reg, 'ЗДДС')?.id).toBe('zdds');
    expect(resolveLaw(reg, 'зддс')?.id).toBe('zdds');
    expect(resolveLaw(reg, 'zsch')?.id).toBe('zsch');
    expect(resolveLaw(reg, 'Кодекс на труда')?.id).toBe('kt');
    expect(resolveLaw(reg, 'Кодекса на труда')?.id).toBe('kt');
    expect(resolveLaw(reg, 'VAT act')?.id).toBe('zdds');
    expect(resolveLaw(reg, 'чл. 5 от Закона за счетоводството')?.id).toBe('zsch');
    expect(resolveLaw(reg, 'nonsense')).toBeNull();
  });

  it('resolves EU acts and topics', () => {
    expect(resolveEu(reg, 'GDPR')?.celex).toBe('32016R0679');
    expect(resolveEu(reg, '2016/679')?.celex).toBe('32016R0679');
    expect(resolveTopic(reg, 'accounting')?.id).toBe('accounting');
    expect(resolveTopic(reg, 'Счетоводство и финансови отчети')?.id).toBe('accounting');
  });
});

describe('amendment detection', () => {
  it('finds direct amendments and repeals from titles', () => {
    expect(isAmendingTitle('Закон за изменение и допълнение на Закона за данък върху добавената стойност')).toBe(true);
    expect(directTarget('Закон за изменение и допълнение на Закона за данък върху добавената стойност', reg.laws)?.id).toBe('zdds');
    expect(directTarget('Закон за допълнение на Кодекса на труда', reg.laws)?.id).toBe('kt');
    expect(directTarget('Закон за изменение на Данъчно-осигурителния процесуален кодекс', reg.laws)?.id).toBe('dopk');
    expect(directTarget('Закон за счетоводството', reg.laws)).toBeNull();
    expect(repealTarget('Закон за отменяне на Закона за счетоводството', reg.laws)?.id).toBe('zsch');
  });

  it('prefers the longest matching law name', () => {
    expect(directTarget('Закон за изменение и допълнение на Закона за търговския регистър и регистъра на юридическите лица с нестопанска цел', reg.laws)?.id).toBe('ztrrjlnc');
    expect(directTarget('Закон за изменение на Закона за търговския регистър', reg.laws)?.id).toBe('ztrrjlnc');
  });

  it('finds amendments hidden inside other acts', () => {
    expect(indirectTarget('§ 43. В Закона за счетоводството (обн., ДВ, бр. 95 от 2015 г.) се правят следните изменения:', reg.laws)?.id).toBe('zsch');
    expect(indirectTarget('§ 7. В чл. 5, ал. 1 от Закона за корпоративното подоходно облагане (обн., ДВ ...) думите ...', reg.laws)?.id).toBe('zkpo');
    expect(indirectTarget('§ 12. В Кодекса за социално осигуряване (обн., ДВ ...) се правят следните изменения:', reg.laws)?.id).toBe('kso');
    expect(indirectTarget('§ 3. Министърът на финансите издава наредба по Закона за счетоводството.', reg.laws)).toBeNull();
    // "Закона за счетоводството" must not match a longer, different law name
    expect(indirectTarget('§ 4. В Закона за счетоводството на бюджетните организации (обн., ДВ ...) се правят изменения:', reg.laws)).toBeNull();
  });
});
