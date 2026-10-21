# Changelog

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
