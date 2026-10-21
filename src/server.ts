import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from './db.js';
import { loadRegistry, registryFromJson, type Registry } from './registry.js';
import { LexBG } from './service.js';
import {
  SERVER_INSTRUCTIONS, checkCitationsPrompt, complianceReviewPrompt, researchPrompt, whatsNewPrompt,
} from './workflow.js';

export const VERSION = '0.2.0';

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

function json(result: unknown) {
  const isError = typeof result === 'object' && result !== null && 'error' in result;
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    isError,
  };
}

/**
 * `source` may be a ready database or a promise (the server starts immediately and the first
 * tool call waits while the prebuilt database is downloaded on first run).
 */
export function createServer(source: Db | Promise<Db>, reg?: Registry): McpServer {
  const ready: Promise<LexBG> = Promise.resolve(source).then(db => new LexBG(db, reg ?? registryFor(db)));
  ready.catch(() => undefined); // errors are reported per tool call
  const run = async (fn: (lex: LexBG) => unknown) => {
    try {
      return json(fn(await ready));
    } catch (err) {
      return json({ error: `LexBG database is not available: ${err instanceof Error ? err.message : String(err)}` });
    }
  };
  const server = new McpServer({ name: 'lexbg', version: VERSION }, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool('about', {
    title: 'About LexBG',
    description: 'Coverage, data freshness, topic list and sources of the local LexBG database. Call first if unsure what is available.',
    inputSchema: {},
    annotations: readOnly,
  }, async () => run(lex => lex.about()));

  server.registerTool('list_laws', {
    title: 'List laws',
    description: 'List tracked Bulgarian laws and EU acts with their text status (consolidated / original / missing), amendment counts and topics.',
    inputSchema: {
      topic: z.string().optional().describe('Topic id, e.g. "accounting", "vat", "employment", "aml", "data-protection"'),
      kind: z.enum(['bg', 'eu']).optional().describe('"bg" for Bulgarian laws, "eu" for EU acts'),
    },
    annotations: readOnly,
  }, async args => run(lex => lex.listLaws(args)));

  server.registerTool('search_law', {
    title: 'Search legislation',
    description:
      'Full-text search over Bulgarian laws and EU acts (Bulgarian text). Returns ranked provisions with snippets and citations. ' +
      'Use Bulgarian legal vocabulary, e.g. "срок за съхраняване на счетоводна информация". Narrow with law or topic.',
    inputSchema: {
      query: z.string().min(2).describe('Search words, preferably in Bulgarian'),
      law: z.string().optional().describe('Restrict to one law: abbreviation (ЗДДС), id (zdds), title, or EU short name (GDPR)'),
      topic: z.string().optional().describe('Restrict to the laws of a topic pack, e.g. "accounting"'),
      limit: z.number().int().min(1).max(30).optional().describe('Max results (default 8)'),
      include_eu: z.boolean().optional().describe('Include EU acts (default true)'),
    },
    annotations: readOnly,
  }, async args => run(lex => lex.search(args)));

  server.registerTool('get_provision', {
    title: 'Get provision',
    description:
      'Verbatim text of one provision: an article ("чл. 6а"), a paragraph of the additional/transitional provisions ("§ 1 ДР"), ' +
      'optionally a single алинея/точка. Also lists EU acts it references and later amendments that mention it.',
    inputSchema: {
      law: z.string().optional().describe('Law abbreviation/id/title, e.g. "ЗСч" or "zsch". Optional if included in provision.'),
      provision: z.string().describe('e.g. "чл. 6", "6а", "чл. 12, ал. 2, т. 3", "§ 1 ДР", "§ 5 ПЗР"'),
      paragraph: z.string().optional().describe('Алинея number, e.g. "2"'),
      point: z.string().optional().describe('Точка number, e.g. "3"'),
    },
    annotations: readOnly,
  }, async args => run(lex => lex.getProvision(args)));

  server.registerTool('validate_citation', {
    title: 'Validate citation',
    description: 'Check that a citation such as "чл. 6, ал. 1 ЗЗЛД" or "§ 1, т. 5 от ДР на ЗСч" exists in the stored text, and return the cited text. Use it to catch hallucinated citations.',
    inputSchema: {
      citation: z.string().describe('The citation to check'),
    },
    annotations: readOnly,
  }, async ({ citation }) => run(lex => lex.validateCitation(citation)));

  server.registerTool('what_changed', {
    title: 'What changed',
    description:
      'Amendment history of a Bulgarian law from parliament.bg: amending acts AND amendments hidden inside other acts ' +
      '("В Закона за ... се правят следните изменения"). Filter by date and by article.',
    inputSchema: {
      law: z.string().describe('Law abbreviation/id/title, e.g. "ЗДДС"'),
      since: z.string().optional().describe('ISO date, e.g. "2024-01-01"'),
      until: z.string().optional().describe('ISO date'),
      article: z.string().optional().describe('Only changes that mention this article, e.g. "чл. 96" or "96"'),
      limit: z.number().int().min(1).max(100).optional().describe('Max acts (default 20)'),
      include_text: z.boolean().optional().describe('Include the amending text (default true)'),
    },
    annotations: readOnly,
  }, async args => run(lex => lex.whatChanged(args)));

  server.registerTool('eu_links', {
    title: 'EU links',
    description: 'Which EU regulations/directives a Bulgarian law refers to, or which Bulgarian provisions refer to a given EU act (e.g. GDPR → ЗЗЛД).',
    inputSchema: {
      law: z.string().optional().describe('Bulgarian law, e.g. "ЗМИП"'),
      eu_act: z.string().optional().describe('EU act: CELEX (32016R0679), short name (GDPR) or citation (Регламент (ЕС) 2016/679)'),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: readOnly,
  }, async args => run(lex => lex.euLinks(args)));

  server.registerTool('get_topic', {
    title: 'Compliance topic',
    description: 'A compliance topic pack (e.g. company-formation, accounting, vat, employment, aml, data-protection, consumer-ecommerce, euro-changeover): laws involved, typical questions and the key provisions to read.',
    inputSchema: {
      topic: z.string().describe('Topic id or title'),
      per_query: z.number().int().min(1).max(5).optional().describe('Provisions per standard query (default 2)'),
    },
    annotations: readOnly,
  }, async args => run(lex => lex.getTopic(args)));

  server.registerTool('compliance_checklist', {
    title: 'Compliance checklist',
    description:
      'Given a short profile of a person or business, return the compliance topics that likely apply, why, the laws involved and the first provisions to read. ' +
      'A map for research — it does not decide whether a specific obligation applies.',
    inputSchema: {
      entity_type: z.enum(['person', 'freelancer', 'ET', 'EOOD', 'OOD', 'AD', 'NGO', 'other']).optional()
        .describe('person = private individual, freelancer = свободна професия, ET = едноличен търговец'),
      has_employees: z.boolean().optional(),
      processes_personal_data: z.boolean().optional(),
      sells_to_consumers: z.boolean().optional(),
      sells_online: z.boolean().optional(),
      vat_status: z.enum(['registered', 'not_registered', 'unsure']).optional(),
      aml_obliged: z.enum(['yes', 'no', 'unsure']).optional().describe('Is the business an obliged entity under the AML law (ЗМИП)?'),
      sector: z.array(z.enum(['finance', 'payments', 'investment', 'crypto', 'credit', 'accounting', 'real_estate', 'legal', 'gambling', 'critical_infrastructure', 'digital', 'other'])).optional(),
    },
    annotations: readOnly,
  }, async args => run(lex => lex.checklist(args)));

  server.registerTool('get_obligations', {
    title: 'Get obligations',
    description: 'Structured obligations (who must do what, by when) extracted from a law, each with a verbatim, verified quote and citation. Only available for laws where extraction has been run.',
    inputSchema: {
      law: z.string().describe('Law abbreviation/id'),
      provision: z.string().optional().describe('Limit to one provision, e.g. "чл. 38"'),
      include_unreviewed: z.boolean().optional().describe('Include items not yet reviewed by a person (default true)'),
    },
    annotations: readOnly,
  }, async args => run(lex => lex.getObligations(args)));

  // Prompts: reusable workflows. Clients show them as slash commands / prompt templates.
  server.registerPrompt('legal_research', {
    title: 'Bulgarian legal research',
    description: 'Answer a legal question with LexBG: search, quote the provisions, check amendments and citations.',
    argsSchema: { question: z.string().describe('The question, in Bulgarian or English') },
  }, ({ question }) => userPrompt(researchPrompt(question)));

  server.registerPrompt('compliance_review', {
    title: 'Compliance review of a business',
    description: 'Map the compliance areas, laws and first provisions to read for a described business.',
    argsSchema: { business: z.string().describe('What the business does: legal form, employees, customers, online sales, sector...') },
  }, ({ business }) => userPrompt(complianceReviewPrompt(business)));

  server.registerPrompt('whats_new', {
    title: 'What changed in a law',
    description: 'Plain-language summary of the amendments to a law since a date, with citations.',
    argsSchema: {
      law: z.string().describe('Law, e.g. "ЗДДС"'),
      since: z.string().optional().describe('ISO date, e.g. 2025-01-01'),
    },
  }, ({ law, since }) => userPrompt(whatsNewPrompt(law, since ?? '')));

  server.registerPrompt('check_citations', {
    title: 'Check citations in a text',
    description: 'Validate every legal citation in a contract, memo or AI answer against the stored texts.',
    argsSchema: { text: z.string().describe('The text containing citations') },
  }, ({ text }) => userPrompt(checkCitationsPrompt(text)));

  return server;
}

/** Prefer the registry stored in the database (it matches the data), else the bundled sources/*.yml. */
export function registryFor(db: Db): Registry {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'registry'").get() as { value: string } | undefined;
    if (row?.value) return registryFromJson(row.value);
  } catch {
    // older database without a stored registry
  }
  return loadRegistry();
}

function userPrompt(text: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
}
