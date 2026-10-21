# data/manual — consolidated texts from official sources

Put the current (consolidated) text of a law here as `<law-id>.html` or `<law-id>.txt`,
next to a `<law-id>.yml` that says where it came from:

```yaml
source_url: https://<official-site>/<page>
current_as_of: 2026-07-31   # last State Gazette issue included
retrieved_at: 2026-10-21
note: Consolidated text published by <institution>
```

Law ids are in `sources/laws.yml`. Then run `npm run build:db`.
Full instructions and the sources you must not use: [DATA_SOURCES.md](../../DATA_SOURCES.md).
