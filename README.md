<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/hero-dark.png">
    <img src="docs/assets/hero.png" alt="LexBG — Bulgarian law for AI assistants: verbatim, cited, and honest about what is current" width="100%">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/StanK1/lexbg-mcp/actions/workflows/ci.yml"><img src="https://github.com/StanK1/lexbg-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/StanK1/lexbg-mcp/actions/workflows/data.yml"><img src="https://github.com/StanK1/lexbg-mcp/actions/workflows/data.yml/badge.svg" alt="Weekly data build"></a>
  <a href="https://github.com/StanK1/lexbg-mcp/releases/latest"><img src="https://img.shields.io/github/v/release/StanK1/lexbg-mcp?label=release&color=0E7A5A" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/MCP-server-16202B" alt="MCP server">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license">
</p>

<p align="center">
  <a href="https://stank1.github.io/lexbg-mcp/"><b>Website</b></a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#what-you-can-ask">Use cases</a> ·
  <a href="docs/TOOLS.md">Tool reference</a> ·
  <a href="docs/HOW_IT_WORKS.md">How it works</a> ·
  <a href="#на-български">На български</a>
</p>

**LexBG** is an open-source [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude and other AI assistants reliable access to Bulgarian legislation. Answers quote the law word for word, cite it the Bulgarian way (`чл. 12, ал. 1 ЗСч`), show what changed since, and say plainly when a text may not be current.

It runs on your machine. One line in Claude Desktop installs it; a 6 MB database, rebuilt every week from parliament.bg and EUR-Lex, downloads on first start.

> [!NOTE]
> LexBG is a research tool, not legal advice. Verify important answers in the State Gazette (Държавен вестник) or with a professional. See [DISCLAIMER.md](DISCLAIMER.md).

## Why LexBG

Ask a general-purpose AI about Bulgarian law and it answers from memory: plausible, often outdated, sometimes citing articles that don't exist. The underlying problem is that **a Bulgarian law in force is not one document.** It is the act as adopted plus every later amendment, and most amendments are not where you would look for them.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/amendments-dark.png">
  <img src="docs/assets/amendments.png" alt="Timeline: 22 of 25 changes to the Accounting Act since 2015 were made inside other laws; only 3 were amending acts titled for the Accounting Act" width="100%">
</picture>

Across the 33 laws LexBG tracks, **935 of 1,157 amendments (81 %) were made inside other laws**: a paragraph in the VAT Act changes the Accounting Act, the budget law changes the tax code, the euro law changes sixteen laws at once. LexBG reads every act the National Assembly adopts and links those hidden changes to the law they modify.

Three principles follow from that:

| | |
|---|---|
| **Verbatim, never paraphrased** | Every provision comes from the official text, with its citation and source link. `validate_citation` catches references that don't exist. |
| **Honest about currency** | Each law is marked `consolidated` (current text), `original` (as first adopted; later amendments not applied) or `missing` (amendment history only). That status and a plain-language warning travel with every answer. |
| **Changes are first-class** | `what_changed` lists every amending act for a law or a single article, including amendments buried in other laws, with State Gazette references. |

## What you can ask

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/example-dark.png">
  <img src="docs/assets/example.png" alt="Example: asked how long payroll records must be kept, Claude calls search_law, get_provision and what_changed, quotes чл. 12, ал. 1, т. 1 ЗСч (50 years) and shows that the text is the original version and that no amendment mentions чл. 12" width="100%">
</picture>

| Who | Typical question | What LexBG brings |
|---|---|---|
| **Founder or freelancer** | *„Имам ЕООД с двама служители и онлайн магазин. Какво трябва да спазвам?“* | `compliance_checklist` maps the business to the areas that apply (accounting, VAT, employment, consumer law, euro changeover…) with the first provisions to read |
| **Accountant** | *„Какво се промени в Закона за счетоводството от 2024 г. насам?“* | Every amending act since that date, including changes hidden in the euro law and the budget law, with the amending text |
| **Compliance team at a bank or fintech** | *„Кой е действителен собственик по ЗМИП и коя директива стои зад него?“* | The legal definition (`§ 2 от ДР на ЗМИП`), the EU directive it implements, and DORA / AMLR / MiCA texts in Bulgarian |
| **Developer building legal AI** | *„Провери цитатите в този договор.“* | A citation checker and verbatim retrieval you can put under any model, with a measured search quality |
| **Citizen** | *„Мога ли да се откажа от потребителски кредит?“* | The exact right and deadline (`чл. 29 ЗПК` — 14 days), quoted, plus whether the text has changed |

## Quick start

You need **Node.js 22.13 or newer** (`node --version`). Nothing to clone or build.

**Claude Desktop** · Settings → Developer → Edit Config:

```json
{
  "mcpServers": {
    "lexbg": {
      "command": "npx",
      "args": ["-y", "https://github.com/StanK1/lexbg-mcp/releases/latest/download/lexbg.tgz"]
    }
  }
}
```

Restart Claude Desktop and start a new chat. LexBG appears in the tools menu.

<details>
<summary><b>Claude Code, Docker and other clients</b></summary>

**Claude Code**

```bash
claude mcp add lexbg -- npx -y https://github.com/StanK1/lexbg-mcp/releases/latest/download/lexbg.tgz
```

**Docker**

```bash
docker run -i --rm -v lexbg-data:/data ghcr.io/stank1/lexbg
```

**Any MCP client** — run the `npx` command above as a stdio server.

| Setting | Default | Purpose |
|---|---|---|
| `LEXBG_DB` | – | Use this database file instead of downloading |
| `LEXBG_HOME` | `~/.lexbg` | Where the downloaded database lives |
| `LEXBG_OFFLINE=1` | off | Never use the network (needs a cached or local database) |

</details>

On first start LexBG downloads the weekly database (about 6 MB, checksum-verified) to `~/.lexbg/`. A new user is ready in about ten seconds; later starts take about one second and work offline. Once a day it checks for a newer weekly build in the background.

**Recommended:** add the Claude skill [`lexbg-research`](skills/lexbg-research/SKILL.md) (`lexbg-research-skill.zip` in the [latest release](https://github.com/StanK1/lexbg-mcp/releases/latest)). It teaches Claude the full method: search, quote, check amendments, validate citations.

## Tools and prompts

| Tool | What it answers |
|---|---|
| `search_law` | Full-text search in Bulgarian, ranked, with snippets, citations and a note when the relevant law has no text yet |
| `get_provision` | Verbatim article, § of the additional/transitional provisions, алинея or точка, plus EU references and later amendments that mention it |
| `what_changed` | Amendment history of a law, by date and by article, including amendments inside other laws |
| `validate_citation` | Does `чл. 6, ал. 1 ЗЗЛД` exist, and what does it say? |
| `compliance_checklist` | Business profile in, applicable compliance areas out, with reasons and provisions to read |
| `get_topic` | One of 18 compliance topics: laws, typical questions, key provisions |
| `eu_links` | EU acts a law refers to, or Bulgarian provisions that refer to an EU act |
| `list_laws` · `about` | What is covered, how current it is, where it came from |
| `get_obligations` | Structured obligations (who / must / by when) with verified quotes — optional AI layer |

Four **prompts** package the method as one-click workflows: `legal_research`, `compliance_review`, `whats_new`, `check_citations`. Full parameters and example output: [docs/TOOLS.md](docs/TOOLS.md).

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/how-it-works-dark.png">
  <img src="docs/assets/how-it-works.png" alt="Official sources (parliament.bg, EUR-Lex) → weekly build on GitHub Actions → lexbg.db on your machine → Claude and any MCP client" width="100%">
</picture>

- **Sources.** Every act the National Assembly has adopted since about 2005 (parliament.bg), and 17 EU acts in Bulgarian from the Publications Office (GDPR, DORA, the AI Act, NIS2, AMLR, MiCA, PSD2, the VAT Directive and others).
- **Weekly build.** A GitHub Action fetches new acts, parses them into articles and §, links amendments, runs 57 tests and the search evaluation, and publishes the database. If search quality drops, nothing is published.
- **On your machine.** One SQLite file with full-text search. LexBG does not run a model and sends nothing anywhere; your AI client decides when to call it.

More detail, including exactly what the AI sees: [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md).

## Coverage today

| | |
|---|---|
| Promulgated acts in the catalogue | 2,064 (2005 → present), rebuilt weekly |
| Amendment links found | 1,157 (81 % inside other laws) |
| Bulgarian laws tracked | 33 — 9 with original text, 24 with amendment history only |
| EU acts with full Bulgarian text | 17 |
| Compliance topics | 18 |

parliament.bg publishes each act **as adopted**, so for laws adopted since 2005 LexBG has the original text plus the full amendment trail, and for older laws (the Labour Code, the Commercial Act, the VAT Act) only the amendment trail. Current consolidated texts can be added from official sources; see [DATA_SOURCES.md](DATA_SOURCES.md). LexBG never presents an original text as current.

## Search quality

Search is measured on 32 real questions with answers verified by reading the law ([evals/retrieval.yml](evals/retrieval.yml)), and the weekly build fails if quality drops.

| | correct provision first | in top 3 | in top 5 | MRR |
|---|---:|---:|---:|---:|
| v0.2 keyword search | 56 % | 72 % | 78 % | 0.65 |
| **v0.3 relaxed matching + reranking** | **72 %** | **88 %** | **88 %** | **0.80** |

## Build the data yourself

```bash
git clone https://github.com/StanK1/lexbg-mcp.git && cd lexbg-mcp
npm install && npm run build
npm run fetch:parliament        # all acts (~45 min the first time; resumable)
npm run fetch:eurlex            # EU acts via the Publications Office API
npm run build:db && npm run coverage && npm test
```

A database built in the repository (`data/lexbg.db`) takes priority over the downloaded one. Step-by-step guide: [docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md).

<details>
<summary><b>Project layout</b></summary>

```
sources/      laws.yml · eu.yml · topics.yml — the registry (add laws and topics here)
src/          MCP server, query layer, parsers for Bulgarian and EU acts, citations, amendments
scripts/      fetchers, database builder, coverage, evaluation, obligation extraction
fixtures/     real public-domain acts used by the tests
evals/        search evaluation sets with verified answers
tests/        unit and end-to-end tests (a real MCP client against the server)
docs/         guides, tool reference, images
site/         the project website (GitHub Pages)
```

Built with the official TypeScript MCP SDK and Node's built-in SQLite. No native dependencies.

</details>

## Roadmap

- [ ] Current consolidated texts for the core laws (Labour Code, VAT, corporate and personal income tax, social security, Commercial Act) from official sources
- [ ] Hybrid search (embeddings next to full-text search), measured with the evaluation
- [ ] Hosted endpoint for trying LexBG without installing anything
- [ ] Court decisions and regulator guidance (data protection authority, tax authority)
- [ ] Benchmark: answers with and without LexBG on 100 Bulgarian compliance questions

## Contributing

Issues and pull requests are welcome — new laws for the registry, parser fixes, evaluation questions, consolidated texts from official sources. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

## Acknowledgements and legal

- Normative acts and acts of state bodies are not subject to copyright in Bulgaria (чл. 4, т. 1 ЗАПСП). EU texts © European Union, [eur-lex.europa.eu](https://eur-lex.europa.eu), reused under the EUR-Lex legal notice. LexBG does not use commercial legal databases.
- The parliament.bg endpoints were first documented by Ansvar Systems' open-source [Bulgarian Law MCP](https://github.com/Ansvar-Systems/Bulgarian-law-mcp), which served as a reference. LexBG is an independent implementation.
- Code: [MIT License](LICENSE). Changes: [CHANGELOG.md](CHANGELOG.md).

---

## На български

**LexBG** е MCP сървър с отворен код, който дава на Claude и други AI асистенти надежден достъп до българското законодателство. Отговорите цитират закона дословно (`чл. 12, ал. 1 ЗСч`), показват какво се е променило след това и казват ясно, когато текстът може да не е актуален.

**Защо:** действащият закон не е един документ, а първоначалният текст плюс всички изменения — а 81 % от измененията на следените закони са направени в *други* закони (например чрез закона за еврото или закона за бюджета). LexBG чете всеки приет от Народното събрание акт и свързва тези скрити промени със закона, който променят.

**Инсталация за една минута** — Claude Desktop → Settings → Developer → Edit Config:

```json
{ "mcpServers": { "lexbg": { "command": "npx", "args": ["-y", "https://github.com/StanK1/lexbg-mcp/releases/latest/download/lexbg.tgz"] } } }
```

При първо стартиране се изтегля готовата база данни (около 6 MB, обновява се всяка седмица от parliament.bg и EUR-Lex). След това LexBG стартира за секунда и работи офлайн.

**Примери:** *„Колко години се пазят ведомостите за заплати?“* · *„Какво се промени в ЗДДС от 2025 г.?“* · *„Имам ЕООД с онлайн магазин — какво трябва да спазвам?“* · *„Провери цитатите в този договор.“*

LexBG е инструмент за проучване, а не правен съвет. Проверявайте важните отговори в Държавен вестник или с адвокат или счетоводител.
