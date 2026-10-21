# Data sources

LexBG only uses **official, freely reusable** sources and downloads them **to your machine**. Nothing is redistributed from a commercial database.

| Source | What LexBG takes | How | Licence / legal basis |
|---|---|---|---|
| **parliament.bg** (National Assembly) | Catalogue and text of every promulgated act since ~2005: new laws, amending acts, codes | `npm run fetch:parliament` — public JSON endpoints used by the site itself (`/api/v1/archive-list`, `/archive-period`, `/act/{id}`); undocumented, may change | Normative acts are not subject to copyright — чл. 4, т. 1 ЗАПСП |
| **EUR-Lex** (Publications Office of the EU) | Bulgarian text of the EU acts in `sources/eu.yml` | `npm run fetch:eurlex` — `legal-content/BG/TXT/HTML/?uri=CELEX:…` | EUR-Lex content may be reused free of charge (EUR-Lex legal notice) |
| **Official consolidated texts** you add | Current wording of a law | Save into `data/manual/` (see below) | Must come from a state body — not from a commercial database |

Both fetchers identify themselves (`User-Agent: LexBG/0.1 (+https://github.com/StanK1/LexBG)`), wait between requests (1.2 s for parliament.bg, 2 s for EUR-Lex) and resume where they stopped. Please keep it that way.

## What the text status means

| Status | Meaning | What to tell the user |
|---|---|---|
| `consolidated` | Current text imported from an official consolidated publication, current as of `current_as_of` | Text is current up to that date; `what_changed --since <date>` shows anything newer |
| `original` | The act as first promulgated on parliament.bg | Later amendments are **not applied** — the wording may be outdated |
| `missing` | No text stored | Amendment history still works; add a consolidated text |

`npm run coverage` (or the `about` / `list_laws` tools) shows the status of every law.

## Adding a consolidated text

1. **Find an official source.** The current text of a law is usually published by the state body responsible for it — for example the ministry or agency that applies the law (the tax authority and Ministry of Finance for tax laws, the Ministry of Labour for labour law, the data-protection commission for its law). Check that:
   - the page is on the institution's own official website;
   - it states which amendments are included (the last State Gazette issue, "ДВ бр. … от …").
2. **Save the text** as `data/manual/<law-id>.html` (browser → *Save page as… → Web page, HTML only*) or copy it into `data/manual/<law-id>.txt`. The law id is the `id` in `sources/laws.yml` — e.g. `kt` for the Labour Code, `zdds` for the VAT Act.
3. **Describe the source** in `data/manual/<law-id>.yml`:

   ```yaml
   source_url: https://<official-site>/<page-with-the-law>
   current_as_of: 2026-07-31        # date of the last State Gazette issue included in the text
   retrieved_at: 2026-10-21         # when you downloaded it
   note: Consolidated text published by <institution>, incl. ДВ бр. 61 от 2026 г.
   ```

4. **Rebuild and check**:

   ```bash
   npm run build:db
   npm run coverage                                   # the law should now be "consolidated"
   ```

   Then ask your MCP client for `what_changed` on that law `since` the `current_as_of` date. If amendments show up, the text is already behind — note it or find a newer one.

The parser expects the usual layout of Bulgarian legislation: `Чл. N.` for articles, `§ N.` for paragraphs, and headings such as `ДОПЪЛНИТЕЛНИ РАЗПОРЕДБИ`, `ПРЕХОДНИ И ЗАКЛЮЧИТЕЛНИ РАЗПОРЕДБИ`, `Глава …`, `Раздел …`. Annotations like `(Изм. – ДВ, бр. 95 от 2015 г.)` are kept as part of the text.

Consolidated texts of laws are themselves normative acts of the state and not copyrighted, so you may commit `data/manual/` files that come from official sources — that is how the community can share current texts.

## Sources you must not use

- **Commercial legal information systems** (for example Lex.bg, APIS, Ciela) — their consolidated databases, annotations and case-law collections are their product and are protected as databases and by their terms of use, even though the underlying laws are public.
- Anything behind a login, a paywall or a CAPTCHA.
- Court decisions with personal data that were **not** anonymised by the court — and never try to re-identify anonymised parties.

## Known limitations

- **Consolidation is the hard part.** The State Gazette publishes amendments, not current texts. LexBG tracks the amendments but does not apply them to the original text automatically.
- **Hidden-amendment detection** looks for the standard drafting formula ("§ N. В Закона за … (обн., ДВ …) се правят …", "В чл. N от Закона за …"). Unusual wording can be missed; renamed laws need their former names in `genitives`.
- **Dates** are promulgation dates; entry into force can differ and is stated in each act's final provisions.
- **parliament.bg's catalogue** starts around 2005, so older laws have no original text there — only their later amendments.
- **EU acts** are stored as published in the Official Journal; later amendments to the EU act are not applied.
