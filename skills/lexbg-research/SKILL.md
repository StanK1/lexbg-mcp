---
name: lexbg-research
description: Research Bulgarian law and compliance with the LexBG MCP server — find and quote provisions, check later amendments, map a business's obligations and validate citations. Use for any question about Bulgarian legislation, taxes, accounting, employment, AML, data protection, consumer rights or the euro changeover when the LexBG tools are connected.
---

# Bulgarian legal research with LexBG

LexBG is an MCP server with verbatim Bulgarian and EU legal texts, amendment history and compliance topic maps. Its tools are read-only. This skill describes **how to use them so the answer is grounded, current and honest.**

## When to use

- Questions about what a Bulgarian law says, requires or allows ("Колко години се пазят ведомостите?", "Кога се регистрирам по ДДС?").
- "What applies to my business?" questions (legal form, employees, online shop, sector).
- "What changed in law X since date Y?"
- Checking citations in a contract, memo or another AI's answer.

## Method

1. **Orient.** If unsure what is covered, call `about` or `list_laws`. Note each law's `text_status`:
   - `consolidated` — current text up to its date;
   - `original` — the act as first adopted; **later amendments are not applied**;
   - `missing` — no text; only the amendment history is available.
2. **Find.** Use `search_law` with Bulgarian legal vocabulary. Try two or three phrasings ("съхраняване на счетоводна информация", "срок за съхранение"), and narrow with `law` or `topic`. For broad business questions start with `compliance_checklist` (build the profile from what the user said; ask if a key fact is missing) or `get_topic`.
3. **Read.** Open every provision you will rely on with `get_provision`; use `paragraph` / `point` for the exact алинея / точка. Quote the operative sentence verbatim.
4. **Check currency.** Call `what_changed` for each law you rely on — with `article` for the specific provision. `get_provision` also lists `possible_later_changes` that mention the article. If the text is `original` and amendments exist, say the wording may be outdated and summarise what the amendments change.
5. **Verify citations.** Run `validate_citation` on any citation you did not just retrieve, including citations the user gave you.
6. **EU layer.** For laws implementing EU law, `eu_links` shows the directive or regulation behind them.

## Answer format

- Answer in the user's language.
- **Short answer first**, then the supporting provisions: quote + citation in Bulgarian style (`чл. 12, ал. 1, т. 2 ЗСч`, `§ 1, т. 5 от ДР на ЗДДС`), then caveats (text status, amendments, entry into force, exceptions).
- For business mappings use a table: area | why it applies | laws | provisions to read | open questions.

## Rules

- **Never invent** article numbers, thresholds, amounts or deadlines. If LexBG has no text for a law, say so and point to the State Gazette or the responsible institution.
- Never present an `original` text as current law.
- Adoption dates are not entry-into-force dates — the act's final provisions decide.
- `compliance_checklist` and topic packs show **where to look**, not whether an obligation applies; thresholds and exceptions must be read in the text.
- End substantive answers with: research only, not legal advice — verify in Държавен вестник or with a qualified professional (адвокат, счетоводител).

## Prompts provided by the server

LexBG also exposes these workflows as MCP prompts (slash commands in clients that support them): `legal_research`, `compliance_review`, `whats_new`, `check_citations`.
