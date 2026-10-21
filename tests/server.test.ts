/**
 * End-to-end: build a database from the fixtures (real parliament.bg acts + one synthetic
 * "consolidated" text), start the MCP server in memory and call every tool through a real client.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lexbg-test-'));
const dbFile = path.join(tmp, 'test.db');

let client: Client;
let closeDb: () => void;
let lexForEval: import('../src/service.js').LexBG;

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0].text;
  return { isError: Boolean(res.isError), data: JSON.parse(text) };
}

beforeAll(async () => {
  process.env.LEXBG_RAW = path.join(ROOT, 'fixtures', 'raw');
  // manual texts + a reviewed obligations file, laid out like data/manual and data/obligations
  fs.cpSync(path.join(ROOT, 'fixtures', 'manual-test'), path.join(tmp, 'manual'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'obligations'));
  fs.writeFileSync(path.join(tmp, 'obligations', 'zsch.json'), JSON.stringify({
    law_id: 'zsch', model: 'test', extracted_at: '2026-10-21T00:00:00Z',
    items: [{
      provision: 'Чл. 38', subject: 'предприятията', action: 'публикуват годишния финансов отчет',
      deadline: 'до 30 юни на следващата година', review_status: 'approved',
      quote: 'Предприятията публикуват годишния финансов отчет',
    }],
  }));
  process.env.LEXBG_MANUAL = path.join(tmp, 'manual');
  const { buildDatabase } = await import('../scripts/build-db.js');
  buildDatabase(dbFile);

  const { openDb } = await import('../src/db.js');
  const { loadRegistry } = await import('../src/registry.js');
  const { createServer } = await import('../src/server.js');
  const db = openDb(dbFile, { readOnly: true });
  closeDb = () => db.close();
  const { LexBG } = await import('../src/service.js');
  lexForEval = new LexBG(db, loadRegistry());
  const server = createServer(db, loadRegistry());
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: 'lexbg-test', version: '0.0.0' });
  await client.connect(b);
});

afterAll(async () => {
  await client?.close();
  closeDb?.();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('MCP server', () => {
  it('lists all tools as read-only', async () => {
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual([
      'about', 'compliance_checklist', 'eu_links', 'get_obligations', 'get_provision', 'get_topic',
      'list_laws', 'search_law', 'validate_citation', 'what_changed',
    ]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it('about reports coverage honestly', async () => {
    const { data } = await call('about');
    expect(data.bulgarian_laws).toMatchObject({ consolidated: 1, original_only: 3 });
    expect(data.promulgated_acts).toBe(6);
  });

  it('list_laws shows text status per law', async () => {
    const { data } = await call('list_laws', { topic: 'accounting' });
    const zsch = data.laws.find((l: { id: string }) => l.id === 'zsch');
    expect(zsch).toMatchObject({ text_status: 'original', amendments_total: 3 });
    expect(zsch.warning).toMatch(/3 later amending act/);
  });

  it('search_law finds the record-keeping article of the Accounting Act', async () => {
    const { data } = await call('search_law', { query: 'срокове за съхраняване на счетоводната информация', law: 'ЗСч', limit: 5 });
    const provisions = data.results.map((r: { provision: string }) => r.provision);
    expect(provisions).toContain('Чл. 12');
    expect(data.results[0].citation).toMatch(/ЗСч$/);
  });

  it('search_law finds definitions kept in the additional provisions', async () => {
    const { data } = await call('search_law', { query: 'действителен собственик', law: 'ЗМИП', limit: 3 });
    expect(data.results[0].provision).toBe('§ 2 ДР');
  });

  it('search_law says when the relevant law has no text, instead of silently answering from other laws', async () => {
    const { data } = await call('search_law', { query: 'Кога е задължителна регистрацията по ДДС?' });
    expect(data.coverage_note).toMatch(/Закон за данък върху добавената стойност \(ЗДДС\)/);
    const ok = (await call('search_law', { query: 'действителен собственик' })).data;
    expect(ok.coverage_note).toBeUndefined();
    expect(ok.results[0].citation).toBe('§ 2 от ДР на ЗМИП');
  });

  it('search_law uses a law named in the question as a filter, not as a search word', async () => {
    const { data } = await call('search_law', { query: 'видни политически личности по ЗМИП' });
    expect(data.terms).not.toContain('змип');
    expect(data.results[0].law).toBe('ЗМИП');
  });

  it('get_provision returns verbatim text and the requested алинея', async () => {
    const { data } = await call('get_provision', { law: 'ЗСч', provision: 'чл. 12', paragraph: '1' });
    expect(data.found).toBe(true);
    expect(data.text.startsWith('Чл. 12. (1) Счетоводната информация се съхранява')).toBe(true);
    expect(data.requested_excerpt.startsWith('Чл. 12. (1)')).toBe(true);
    expect(data.requested_excerpt).not.toContain('(2)');
  });

  it('get_provision lists later amendments that mention the article', async () => {
    const { data } = await call('get_provision', { law: 'zsch', provision: '19' });
    const acts = data.possible_later_changes.map((c: { act: string }) => c.act);
    expect(acts).toContain('Закон за въвеждане на еврото в Република България');
  });

  it('get_provision reads a § of the additional provisions', async () => {
    const { data } = await call('get_provision', { provision: '§ 1, т. 2 от ДР на ЗСч' });
    expect(data.citation).toBe('§ 1, т. 2 от ДР на ЗСч');
    expect(data.requested_excerpt).toBe('2. „Група предприятия“ са предприятието майка и всички негови дъщерни предприятия.');
  });

  it('validate_citation separates real, fake and unverifiable citations', async () => {
    expect((await call('validate_citation', { citation: 'чл. 38, ал. 1 ЗСч' })).data.valid).toBe(true);
    expect((await call('validate_citation', { citation: 'чл. 999 ЗСч' })).data.valid).toBe(false);
    expect((await call('validate_citation', { citation: 'чл. 12, ал. 9 ЗСч' })).data.valid).toBe(false);
    expect((await call('validate_citation', { citation: 'чл. 6 ЗЗЛД' })).data.valid).toBeNull();
  });

  it('what_changed includes amendments hidden in other acts', async () => {
    const { data } = await call('what_changed', { law: 'ЗСч', since: '2024-01-01', include_text: false });
    expect(data.total_amending_acts).toBe(3);
    const euro = data.changes.find((c: { act: string }) => c.act.startsWith('Закон за въвеждане на еврото'));
    expect(euro.how).toMatch(/inside another act/);
    expect(euro.sections).toEqual(['§ 43 ПЗР']);
  });

  it('what_changed filters by article', async () => {
    const { data } = await call('what_changed', { law: 'ЗСч', article: 'чл. 19' });
    const byAct = Object.fromEntries(data.changes.map((c: { act: string; sections: Array<{ section: string; text: string }> }) => [c.act, c.sections]));
    // the euro law rewrites the thresholds in чл. 19 ...
    expect(byAct['Закон за въвеждане на еврото в Република България'][0].text).toContain('2. В чл. 19:');
    // ... and the 2024 amending act has a transitional rule about the amended чл. 19
    expect(byAct['Закон за изменение и допълнение на Закона за счетоводството'][0].section).toBe('§ 29 ПЗР');
    // sections of that act which amend OTHER laws are excluded
    expect(JSON.stringify(data.changes)).not.toContain('Закона за публично предлагане на ценни книжа (обн.');
  });

  it('what_changed works for laws without stored text', async () => {
    const { data } = await call('what_changed', { law: 'ЗДДС' });
    expect(data.law.text_status).toBe('missing');
    expect(data.changes[0].act).toBe('Закон за въвеждане на еврото в Република България');
  });

  it('eu_links maps Bulgarian provisions to EU directives', async () => {
    const { data } = await call('eu_links', { law: 'ЗМИП' });
    expect(data.eu_acts_referenced[0]).toMatchObject({ celex: '32015L0849', known_as: 'AMLD4' });
    const back = (await call('eu_links', { eu_act: 'Директива (ЕС) 2015/849' })).data;
    expect(back.bulgarian_provisions_referencing_it.length).toBeGreaterThan(5);
  });

  it('imports a consolidated text from data/manual', async () => {
    const { data } = await call('get_provision', { law: 'ЗДОИ', provision: '2а' });
    expect(data.law.text_status).toBe('consolidated');
    expect(data.law.source_url).toBe('https://example.org/lexbg-test-fixture');
    expect(data.chapter).toBe('Глава първа — ОБЩИ ПОЛОЖЕНИЯ');
  });

  it('compliance_checklist maps a profile to topics with reasons', async () => {
    const { data } = await call('compliance_checklist', { entity_type: 'EOOD', has_employees: true, sells_online: true });
    const ids = data.applicable_topics.map((t: { id: string }) => t.id);
    expect(ids).toEqual(expect.arrayContaining(['company-formation', 'accounting', 'corporate-tax', 'employment', 'vat', 'consumer-ecommerce', 'euro-changeover']));
    expect(ids).not.toContain('payments');
    const accounting = data.applicable_topics.find((t: { id: string }) => t.id === 'accounting');
    expect(accounting.why).toContain('entity type is EOOD');
    expect(accounting.key_provisions.length).toBeGreaterThan(0);
    expect(data.gaps).toContain('КТ: no text in local database');
  });

  it('get_topic returns retrieved provisions, never invented ones', async () => {
    const { data } = await call('get_topic', { topic: 'aml' });
    expect(data.topic.title).toBe('Мерки срещу изпирането на пари');
    for (const p of data.key_provisions) expect(['ЗМИП', 'ЗМФТ', 'AMLD4', 'AMLR']).toContain(p.law);
  });

  it('get_obligations serves reviewed obligations with citations', async () => {
    const { data } = await call('get_obligations', { law: 'ЗСч' });
    expect(data.obligations).toEqual([expect.objectContaining({
      who: 'предприятията', citation: 'чл. 38 ЗСч', deadline: 'до 30 юни на следващата година', review_status: 'approved',
    })]);
  });

  it('get_obligations explains how to generate obligations for other laws', async () => {
    const { data } = await call('get_obligations', { law: 'ЗМИП' });
    expect(data.obligations).toEqual([]);
    expect(data.note).toMatch(/extract:obligations/);
  });

  it('returns helpful errors', async () => {
    const res = await call('get_provision', { law: 'Закон за нищото', provision: '1' });
    expect(res.isError).toBe(true);
    expect(res.data.error).toMatch(/Unknown law/);
  });
});

describe('retrieval eval (fixtures)', () => {
  it('keeps hit@5 at or above the recorded baseline', async () => {
    const YAML = (await import('yaml')).default;
    const { runEval } = await import('../scripts/eval.js');
    const cases = YAML.parse(fs.readFileSync(path.join(ROOT, 'evals', 'fixtures.yml'), 'utf8')).cases;
    const r = runEval(lexForEval, cases);
    // v0.1 keyword search: hit@5 0.79, MRR 0.70 → v0.3 relaxed matching + reranking: hit@5 0.79, MRR 0.74.
    // Raise these when search improves; never lower them to make a change pass.
    expect(r.hit5).toBeGreaterThanOrEqual(0.78);
    expect(r.mrr).toBeGreaterThanOrEqual(0.73);
  });
});
