# Tool reference

LexBG exposes 10 read-only MCP tools and 4 prompts. All tools return JSON. Every result that contains law text also carries the law's `text_status` (`consolidated` / `original` / `missing`) and a plain-language `warning` — pass both on to the user.

Law names are flexible everywhere: an abbreviation (`ЗСч`, `ЗДДС`), an id (`zsch`), the title or its "Закона за …" form, an English alias (`VAT act`), or an EU short name (`GDPR`, `DORA`). `list_laws` shows them all.

- [search_law](#search_law) · [get_provision](#get_provision) · [what_changed](#what_changed) · [validate_citation](#validate_citation)
- [compliance_checklist](#compliance_checklist) · [get_topic](#get_topic) · [eu_links](#eu_links)
- [list_laws](#list_laws) · [about](#about) · [get_obligations](#get_obligations) · [Prompts](#prompts)

---

## search_law

Full-text search over Bulgarian laws and EU acts (Bulgarian text), ranked by how much of the question a provision covers, matches in its title or opening, definitions, and laws named in the question. Bulgarian law ranks above EU acts unless the question is about EU law.

| Parameter | Type | |
|---|---|---|
| `query` | string | The question or search words, preferably in Bulgarian |
| `law` | string? | Restrict to one law |
| `topic` | string? | Restrict to the laws of a topic, e.g. `accounting` |
| `limit` | 1–30 | Default 8 |
| `include_eu` | boolean? | Default true |

```jsonc
// search_law({ "query": "Колко години се пазят ведомостите за заплати?" })
{
  "terms": ["години", "пазят", "ведомостите", "заплати"],
  "match_mode": "all-terms",
  "results": [{
    "law": "ЗСч", "provision": "Чл. 12", "citation": "чл. 12 ЗСч",
    "chapter": "Раздел III — Съхраняване на счетоводна информация",
    "snippet": "… 12. (1) Счетоводната информация се «съхранява» на хартиен и/или на технически носител …",
    "matched_terms": "4/4", "text_status": "original",
    "warning": "Original text (adopted 2015-11-24, ДВ, бр. 95 от 2015 г.). 25 later amending act(s) are NOT applied …"
  }]
}
```

When the question is about a law that has no text in LexBG, the result starts with a `coverage_note`, e.g. *"Probably relevant but with NO text in LexBG yet: Кодекс на труда (КТ). Results below come from other laws; say so to the user."*

## get_provision

Verbatim text of one provision.

| Parameter | Type | |
|---|---|---|
| `provision` | string | `чл. 6`, `6а`, `чл. 12, ал. 2, т. 3`, `§ 1 ДР`, `§ 5 ПЗР`, `Член 6` |
| `law` | string? | Optional if the provision string names the law |
| `paragraph` | string? | Алинея number |
| `point` | string? | Точка number |

Returns `text`, `requested_excerpt` (the алинея/точка), `chapter`, `eu_references` (EU acts cited in it) and `possible_later_changes` — sections of later amending acts that mention this article *of this law* (mentions of the same number in other laws are ignored).

## what_changed

Amendment history of a Bulgarian law from parliament.bg: acts titled as amending it **and** provisions inside other acts that amend it ("§ 43. В Закона за счетоводството … се правят следните изменения").

| Parameter | Type | |
|---|---|---|
| `law` | string | Bulgarian law |
| `since` / `until` | ISO date? | Adoption date range. Default `since`: the date the current law was adopted (older acts amended a predecessor with the same title) |
| `article` | string? | Only changes that mention this article (`чл. 38`, `38`, `§ 1`) |
| `limit` | 1–100 | Default 20 |
| `include_text` | boolean? | Include the amending text (default true) |

```jsonc
// what_changed({ "law": "ЗСч", "article": "38", "include_text": false })
{
  "total_amending_acts": 25,
  "changes": [
    { "act": "Закон за изменение и допълнение на Закона за публичното предлагане на ценни книжа",
      "adopted": "2026-02-26", "state_gazette": "ДВ, бр. 25 от 2026 г.",
      "how": "amended by a provision inside another act", "sections": ["§ 36 ЗР"] },
    { "act": "Закон за изменение и допълнение на Закона за счетоводството",
      "adopted": "2024-08-14", "state_gazette": "ДВ, бр. 72 от 2024 г.",
      "how": "amending act for this law", "sections": ["§ 10", "§ 12"] }
  ]
}
```

Dates are adoption dates; entry into force is set by each act's final provisions.

## validate_citation

| Parameter | Type | |
|---|---|---|
| `citation` | string | `чл. 6, ал. 1 ЗЗЛД`, `§ 1, т. 5 от ДР на ЗСч`, `art. 6(1) GDPR` |

Returns `valid: true` with the normalised citation and the cited text, `false` with the reason (no such article, алинея or точка), or `null` when the law has no stored text and the citation cannot be checked.

## compliance_checklist

| Parameter | Type |
|---|---|
| `entity_type` | `person` · `freelancer` · `ET` · `EOOD` · `OOD` · `AD` · `NGO` · `other` |
| `has_employees`, `processes_personal_data`, `sells_to_consumers`, `sells_online` | boolean |
| `vat_status` | `registered` · `not_registered` · `unsure` |
| `aml_obliged` | `yes` · `no` · `unsure` |
| `sector` | list of `finance`, `payments`, `investment`, `crypto`, `credit`, `accounting`, `real_estate`, `legal`, `gambling`, `critical_infrastructure`, `digital`, `other` |

Returns the applicable topics with `why` (which part of the profile triggered them), the laws involved, questions to check and the first provisions to read, plus `gaps` (laws without text). It is a map for research; it does not decide whether a specific obligation applies.

## get_topic

| Parameter | Type | |
|---|---|---|
| `topic` | string | Topic id or title |
| `per_query` | 1–5 | Provisions per standard query (default 2) |

Topics: `company-formation`, `accounting`, `corporate-tax`, `personal-income-tax`, `vat`, `tax-procedure`, `local-taxes`, `social-security`, `employment`, `aml`, `data-protection`, `consumer-ecommerce`, `financial-services`, `payments`, `cybersecurity`, `euro-changeover`, `citizens-rights`, `whistleblowing`. Topic packs contain no article numbers or thresholds; key provisions are retrieved live from the texts.

## eu_links

| Parameter | Type | |
|---|---|---|
| `law` | string? | Bulgarian law → EU acts it refers to (with mention counts) |
| `eu_act` | string? | EU act (CELEX, short name or citation) → Bulgarian provisions that refer to it |

## list_laws

Optional `topic` and `kind` (`bg` / `eu`). Returns every tracked law with its text status, source, amendment count and last amendment date.

## about

Database build date, latest act in the catalogue, coverage counts, topics and sources. Call it first when unsure what is available.

## get_obligations

| Parameter | Type | |
|---|---|---|
| `law` | string | |
| `provision` | string? | Limit to one provision |
| `include_unreviewed` | boolean? | Default true |

Structured obligations (`who`, `must`, `deadline`) with a verbatim quote and citation. Available only for laws where `npm run extract:obligations` has been run and the result reviewed; every quote is verified to appear word for word in the provision.

---

## Prompts

| Prompt | Arguments | What it runs |
|---|---|---|
| `legal_research` | `question` | Search → read → check amendments → validate citations → answer with quotes and warnings |
| `compliance_review` | `business` | Builds a profile, runs `compliance_checklist`, returns a table of areas, laws, provisions and open questions |
| `whats_new` | `law`, `since?` | Plain-language summary of amendments, grouped by amending act |
| `check_citations` | `text` | Validates every citation in a contract, memo or AI answer |

In Claude Code they appear as `/mcp__lexbg__legal_research` etc.; in Claude Desktop, in the attachment menu of the message box.
