/**
 * How a model should use LexBG. Shared by the server `instructions`, the MCP prompts and
 * (in prose) skills/lexbg/SKILL.md, so the guidance stays consistent everywhere.
 */

export const SERVER_INSTRUCTIONS = [
  'LexBG gives verbatim Bulgarian and EU legal texts with citations, amendment history and compliance topic maps.',
  'Method: (1) search_law with Bulgarian legal terms (or get_topic / compliance_checklist for broad business questions);',
  '(2) get_provision for every provision you rely on and quote it; (3) what_changed for the law (or article) to see later amendments;',
  '(4) validate_citation before giving a citation you did not just retrieve.',
  'Always pass on the "warning" field: "original" texts do not include later amendments; "missing" means no text is stored.',
  'Never invent article numbers, thresholds or deadlines — if LexBG has no text, say so.',
  'LexBG is a research tool, not legal advice; recommend checking the State Gazette and a qualified professional for decisions.',
].join(' ');

export const RESEARCH_METHOD = `Use the LexBG tools and follow this method:
1. If unsure what is available, call about.
2. Find the relevant provisions with search_law (use Bulgarian legal vocabulary; try 2–3 phrasings; narrow with law or topic). For broad business questions start with compliance_checklist or get_topic.
3. Open every provision you rely on with get_provision and quote the relevant sentence verbatim.
4. Call what_changed for each law you rely on (with article when relevant) to check for later amendments, and report them.
5. Report each law's warning (original / consolidated / missing). Never present an "original" text as current law.
6. Run validate_citation on any citation you did not just retrieve.
7. Answer in the user's language: short answer first, then the supporting provisions with citations (e.g. "чл. 12, ал. 1 ЗСч"), then caveats.
8. Do not invent article numbers, thresholds, amounts or deadlines. If LexBG has no text for a law, say so and point to the official source.
9. End with: this is research, not legal advice — verify in the State Gazette (Държавен вестник) or with a qualified professional.`;

export function researchPrompt(question: string): string {
  return `${RESEARCH_METHOD}\n\nQuestion:\n${question}`;
}

export function complianceReviewPrompt(business: string): string {
  return `${RESEARCH_METHOD}

Task: map the Bulgarian compliance areas for the business described below.
- Infer a profile for compliance_checklist (entity_type, has_employees, processes_personal_data, sells_to_consumers, sells_online, vat_status, aml_obliged, sector). If something important is unclear, ask before calling the tool.
- For each applicable topic: why it applies, the laws involved, the 1–3 provisions to read first (quoted, cited), the text-status warning, and the questions to ask an accountant or lawyer.
- Present it as a table, then list gaps (laws LexBG has no text for).
- Do not decide that a specific obligation applies when it depends on thresholds or exceptions — say what to check.

Business:
${business}`;
}

export function whatsNewPrompt(law: string, since: string): string {
  return `Use LexBG's what_changed tool for "${law}"${since ? ` since ${since}` : ''}.
- Group the changes by amending act (date, State Gazette issue if available, link).
- For each act, summarise in plain language what changed in this law, citing the § of the amending act.
- Say clearly which changes came from separate amending acts and which were made inside other laws.
- Note that adoption dates are not entry-into-force dates and that the final provisions of each act decide when it applies.
- If the stored text of the law is "original", warn that these changes are not reflected in it.`;
}

export function checkCitationsPrompt(text: string): string {
  return `Find every Bulgarian or EU legal citation in the text below (e.g. "чл. 6, ал. 1 ЗЗЛД", "§ 1, т. 2 от ДР на ЗСч", "чл. 6 GDPR").
Check each one with LexBG's validate_citation tool and return a table: citation | valid / invalid / cannot verify | normalised citation | what the provision actually says (short quote) | note.
Flag any citation whose quoted content does not match the stored text.

Text:
${text}`;
}
