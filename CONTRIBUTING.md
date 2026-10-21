# Contributing to LexBG

Thanks for helping make Bulgarian law easier to work with. Contributions of all sizes are welcome: a new law in the registry, a better parser rule, an eval case, an official consolidated text.

## Development setup

```bash
npm install
npm test          # unit + end-to-end tests on the fixtures (no network needed)
npm run lint      # TypeScript type-check
npm run build     # compile to dist/
```

The tests build a database from `fixtures/raw` (real, public-domain acts from parliament.bg) and call every tool through a real MCP client.

## Ground rules

1. **Never present stale text as current.** Any change that touches text status, dates or amendments must keep the warnings accurate.
2. **No invented law.** Topic packs (`sources/topics.yml`) must not contain article numbers, thresholds, amounts or deadlines — those always come from the stored texts. A test enforces this.
3. **Official sources only.** Do not add code or data that scrapes commercial legal databases. See [DATA_SOURCES.md](DATA_SOURCES.md).
4. **Be polite to public servers.** Keep the delays in the fetchers.
5. **Measure search changes.** If you change tokenisation or ranking, run the eval before and after and put both numbers in the pull request.

## Common changes

**Add a law** — append an entry to `sources/laws.yml` with the exact official `title`, the `genitive` form used in amending acts ("Закона за …", "Кодекса на …"), any former names in `base_titles` / `genitives`, and its `topics`. Run `npm test`, then `npm run build:db` locally to see what it matches.

**Add a topic pack** — add it to `sources/topics.yml`: laws, EU acts, search `queries` (Bulgarian legal vocabulary), typical `questions` and `applies_if` conditions. Check the result with the `get_topic` tool.

**Add eval cases** — add to `evals/retrieval.yml` (full corpus) or `evals/fixtures.yml` (fixtures, runs in CI). The expected provision must be verified by **reading the law**, not by copying the current search result. Cases that the search currently fails are valuable.

**Contribute a consolidated text** — follow [DATA_SOURCES.md → Adding a consolidated text](DATA_SOURCES.md#adding-a-consolidated-text) and commit both `data/manual/<id>.html|txt` and `<id>.yml`.

## Pull requests

- One topic per pull request, with a short description of what changed and why.
- Include tests for parser or matching changes — real examples from Bulgarian legislation are best.
- `npm test` and `npm run lint` must pass.
