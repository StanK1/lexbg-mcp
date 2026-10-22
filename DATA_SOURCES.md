# Data sources

LexBG only uses **official, freely reusable** sources and downloads them **to your machine**. Nothing is redistributed from a commercial database.

| Source | What LexBG takes | How | Licence / legal basis |
|---|---|---|---|
| **parliament.bg** (National Assembly) | Catalogue and text of every promulgated act since ~2005: new laws, amending acts, codes | `npm run fetch:parliament` — public JSON endpoints used by the site itself (`/api/v1/archive-list`, `/archive-period`, `/act/{id}`); undocumented, may change | Normative acts are not subject to copyright — чл. 4, т. 1 ЗАПСП |
| **EUR-Lex** (Publications Office of the EU) | Bulgarian text of the EU acts in `sources/eu.yml` | `npm run fetch:eurlex` — `legal-content/BG/TXT/HTML/?uri=CELEX:…` | EUR-Lex content may be reused free of charge (EUR-Lex legal notice) |
| **Consolidated texts from public institutions** | A starting text for laws older than the catalogue | `npm run fetch:agency` from `sources/agency-texts.yml`, or save into `data/manual/` (see below) | Must come from a state body — not from a commercial database |

Both fetchers identify themselves (`User-Agent: LexBG/0.1 (+https://github.com/StanK1/lexbg-mcp)`), wait between requests (1.2 s for parliament.bg, 2 s for EUR-Lex) and resume where they stopped. Please keep it that way.

## What the text status means

| Status | Meaning | What to tell the user |
|---|---|---|
| `compiled` | Current text **built by LexBG**: the original act (or an institution's snapshot) with every later amending act applied in order of entry into force. Each change is marked in the text, e.g. `(изм. – ДВ, бр. 72 от 2024 г.)` | Current through the latest act in the catalogue. Check `provision_warning` / `not_applied` in `get_provision` for changes that could not be applied, and say it is not an official consolidation |
| `consolidated` | Current text imported from an official consolidated publication, with no later amendments to apply | Text is current up to that date; `what_changed --since <date>` shows anything newer |
| `original` | The act as first promulgated on parliament.bg | Later amendments are **not applied** — the wording may be outdated |
| `missing` | No text stored | Amendment history still works; add a consolidated text |

`npm run coverage` (or the `about` / `list_laws` tools) shows the status of every law.

## How LexBG compiles the current text

1. Every amending § that concerns the law is parsed into operations: replace a unit, repeal it, insert new units, renumber, change wording (replace / add / delete words, append, punctuation), edit sentences, rename headings.
2. Each § gets its entry-into-force date from the act's final provisions ("Законът влиза в сила от …", "с изключение на § 6, т. 1, който влиза в сила от …", "от датата на въвеждане на еврото"). Dates that depend on publication are estimated as adoption + 7 days.
3. Operations are applied in order of entry into force. Those that take effect after the build date are stored as `pending` and not applied.
4. An instruction that is not understood, or whose target is not found, is stored as `failed` against its provision; the text of that provision stays as it was. A law is published as `compiled` only when at least 75 % of its instructions applied and no more than two amending acts are missing from the catalogue. Otherwise the original text is kept.
5. Completeness check: every amending act lists the earlier amendments of the law ("(обн., ДВ, бр. 95 от 2015 г.; изм., бр. 74 … от 2016 г., …)"). Issues listed there but missing from the catalogue are reported in the law's warning. If the acts of an issue only mention the law (e.g. temporary rules), that issue is reported separately.

To check a compilation against a reference, build as of a past date: `LEXBG_COMPILE_AS_OF=2024-08-31 npm run build:db -- --out /tmp/asof.db`.

## Adding a consolidated text

For laws older than the parliament.bg catalogue (≈ 2009), LexBG needs a starting text. It does not have to be recent: LexBG reads its "Обн. ДВ … изм. ДВ …" header, finds the last issue it includes, and applies everything published after that.

**The quick way:** add the institution's PDF / HTML link to `sources/agency-texts.yml` and run `npm run fetch:agency`, or pass a file you downloaded: `npm run fetch:agency -- --law kt --file ~/Downloads/kt.pdf --source-url <page> --institution "МТСП"`. It writes `data/manual/<law>.txt` and `.yml`; then `npm run build:db`.

**By hand:**

1. **Find an official source.** The current text of a law is usually published by the state body responsible for it — for example the ministry or agency that applies the law (the tax authority and Ministry of Finance for tax laws, the Ministry of Labour for labour law, the data-protection commission for its law). Check that:
   - the page is on the institution's own official website;
   - it states which amendments are included (the last State Gazette issue, "ДВ бр. … от …").
2. **Save the text** as `data/manual/<law-id>.html` (browser → *Save page as… → Web page, HTML only*) or copy it into `data/manual/<law-id>.txt`. The law id is the `id` in `sources/laws.yml` — e.g. `kt` for the Labour Code, `zdds` for the VAT Act.
3. **Describe the source** in `data/manual/<law-id>.yml`:

   ```yaml
   source_url: https://<official-site>/<page-with-the-law>
   institution: Министерство на труда и социалната политика
   through_gazette: ДВ, бр. 61 от 2026 г.   # last issue included (read from the header if omitted)
   current_as_of: 2026-07-31        # date of the last State Gazette issue included in the text
   retrieved_at: 2026-10-21         # when you downloaded it
   note: Consolidated text published by <institution>, incl. ДВ бр. 61 от 2026 г.
   ```

4. **Rebuild and check**:

   ```bash
   npm run build:db
   npm run coverage                                   # "compiled" if later amendments were applied, else "consolidated"
   ```

The parser expects the usual layout of Bulgarian legislation: `Чл. N.` for articles, `§ N.` for paragraphs, and headings such as `ДОПЪЛНИТЕЛНИ РАЗПОРЕДБИ`, `ПРЕХОДНИ И ЗАКЛЮЧИТЕЛНИ РАЗПОРЕДБИ`, `Глава …`, `Раздел …`. Annotations like `(Изм. – ДВ, бр. 95 от 2015 г.)` are kept as part of the text.

Consolidated texts of laws are themselves normative acts of the state and not copyrighted, so you may commit `data/manual/` files that come from official sources — that is how the community can share current texts.

## Sources you must not use

- **Commercial legal information systems** (for example Lex.bg, APIS, Ciela) — their consolidated databases, annotations and case-law collections are their product and are protected as databases and by their terms of use, even though the underlying laws are public.
- Anything behind a login, a paywall or a CAPTCHA.
- Court decisions with personal data that were **not** anonymised by the court — and never try to re-identify anonymised parties.

## Known limitations

- **Consolidation is automatic but not perfect.** About 91 % of amending instructions apply automatically across the compiled laws (100 % for the Accounting Act). The rest are listed per provision and the text of those provisions stays at its last known wording. Annexes, article titles and some heading changes are not tracked.
- **Hidden-amendment detection** looks for the standard drafting formula ("§ N. В Закона за … (обн., ДВ …) се правят …", "В чл. N от Закона за …"). Unusual wording can be missed; renamed laws need their former names in `genitives`.
- **Dates**: adoption dates come from parliament.bg; entry-into-force dates are read from each act's final provisions, and estimated when they depend on the publication date.
- **parliament.bg's catalogue** starts around 2009 for acts with text, so older laws need a starting text from an institution (see above).
- **EU acts** are stored as published in the Official Journal; later amendments to the EU act are not applied.
