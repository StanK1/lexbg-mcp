# Changelog

## v0.4.0 — 2026-10-22

**Current texts, compiled by LexBG.** The State Gazette publishes amendments, not current texts. LexBG now applies them itself.

- New `compiled` text status. Amending instructions are parsed (replace, repeal, insert, renumber, wording and sentence edits, headings) and applied to the original act in order of **entry into force**, read from each act's final provisions. Examples: "в сила от 1 януари 2025 г.", "с изключение на § 6, т. 1", and the euro changeover on 1 January 2026.
- Changes are marked in the text the way official consolidations do, e.g. `(изм. – ДВ, бр. 72 от 2024 г., в сила от 6.07.2024 г.)`. Repealed units keep their number: `(2) (Отм. – ДВ, бр. 72 от 2024 г.)`.
- 9 laws compiled. 2,328 of 2,554 instructions apply automatically (91 %), including all 160 for the Accounting Act. A law gets the `compiled` status only with at least 75 % applied and no more than two amending acts missing from the catalogue.
- Checked against the Ministry of Finance's consolidated Accounting Act (August 2024): the wording matched in the articles compared.
- `get_provision` returns `amendment_history`, `not_applied` (with the instruction and reason) and `provision_warning`. `validate_citation` flags repealed provisions. `what_changed` shows `in_force` and how many of each act's instructions LexBG applied.
- Completeness check: the amendment chain quoted in later acts ("обн., ДВ …; изм., бр. …") is compared with the catalogue, and gaps are reported in the warning.
- `npm run fetch:agency` imports consolidated texts published by public institutions (PDF / HTML / TXT) for laws older than the catalogue. LexBG reads which State Gazette issues a text already includes and applies the later ones.
- Fix: act sections labelled `§ 114 .` (space before the dot) were merged, hiding amendments, e.g. three ЗСч amendments from 2021 and 2024.
- Database schema 2. LexBG 0.3 keeps using its last downloaded database until updated.

## v0.3.0 — 2026-10-21

**Search quality** (32 verified questions on the weekly database): correct provision first 56 % → 72 %, in the top 3 72 % → 88 %, MRR 0.65 → 0.80.

- Relaxed matching (all words → all but one → pairs) and reranking by question coverage, title/opening matches, definitions and laws named in the question; Bulgarian law before EU acts unless the question is about EU law.
- Stemming no longer over-strips short words (платен ≠ платежна); verb endings handled.
- Small everyday → legal vocabulary bridge (онлайн → от разстояние, откажа → отказ, колко време → срок, ИИ).
- `coverage_note` when the relevant law has no text yet, instead of silently answering from other laws.
- `possible_later_changes` and `what_changed(article)` ignore article numbers that belong to other laws.
- The weekly build fails if search quality drops.
- New README with images, tool reference, project website; repository renamed to `lexbg-mcp`.

## v0.2.0 — 2026-10-21

- One-line install with `npx`; the weekly prebuilt database (about 6 MB) downloads on first start, checksum-verified; updates in the background.
- Weekly GitHub Actions build from parliament.bg and EUR-Lex (Publications Office API); Docker image.
- Four MCP prompts and the `lexbg-research` Claude skill.
- Fix: EU acts with article numbers repeated in annexes.

## v0.1.0 — 2026-10-21

- First release: 10 MCP tools, amendment tracking (including amendments inside other acts), explicit text status, structure-aware parser, EU links, 18 compliance topics, retrieval evaluation, optional obligation extraction.
