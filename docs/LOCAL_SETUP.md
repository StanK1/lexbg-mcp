# Local setup — step by step

This guide takes you from an empty folder to LexBG answering questions in Claude Desktop. Total time: about 15 minutes for the quick start, plus ~45 minutes of unattended downloading for the complete catalogue.

## 1. Check Node.js

```bash
node --version
```

You need **v22.13 or newer** (LexBG uses Node's built-in SQLite). If it is older, install the current LTS from <https://nodejs.org> or with `nvm install 22` (the repo has an `.nvmrc`).

## 2. Get the code and build it

```bash
git clone https://github.com/StanK1/LexBG.git
cd LexBG
npm install
npm test          # optional: 42 tests on the bundled fixtures, ~3 seconds
npm run build
```

## 3. Download the data

```bash
npm run fetch:parliament -- --only-tracked
```

This downloads the catalogue of acts from parliament.bg and then only the acts whose **title** names one of the 33 tracked laws (their original texts and direct amending acts). Expect a few hundred acts at ~1.3 s each. You can stop with Ctrl+C at any time and run the same command again — it resumes.

When you have time, run the complete download (needed to find amendments hidden inside other laws, e.g. budget laws amending the tax laws):

```bash
npm run fetch:parliament
```

Then the EU acts:

```bash
npm run fetch:eurlex
```

If an EU act fails (EUR-Lex sometimes serves a cookie page to scripts), open the printed URL in your browser, save the page as **HTML only** to `data/raw/eurlex/<CELEX>.html`, and continue.

## 4. Build the database

```bash
npm run build:db
npm run coverage
```

`coverage` prints one line per law: `original` = text as first adopted, `missing` = no text yet, plus how many amendments are not applied. Your first goal is to turn the laws you care about into `consolidated` — see [DATA_SOURCES.md](../DATA_SOURCES.md#adding-a-consolidated-text).

## 5. Check that the server starts

```bash
npm run smoke
```

Expected output ends with `LexBG is ready to use from your MCP client.`

## 6. Connect Claude Desktop

1. Find the absolute path of the server: run `pwd` in the LexBG folder and append `/dist/src/index.js`.
2. In Claude Desktop open **Settings → Developer → Edit Config**. This opens `claude_desktop_config.json`.
3. Add LexBG (keep any servers you already have):

   ```json
   {
     "mcpServers": {
       "lexbg": {
         "command": "node",
         "args": ["/Users/you/LexBG/dist/src/index.js"]
       }
     }
   }
   ```

4. Quit and reopen Claude Desktop. Ask: *"Използвай LexBG: какво има в базата данни?"* — Claude should call the `about` tool.

If Claude Desktop uses a different Node than your terminal (common with nvm), put the full path to node in `"command"` — find it with `which node`.

## 7. Keep it up to date

Once a week (or before an important question):

```bash
npm run fetch:parliament -- --refresh   # new acts since last time
npm run build:db
```

Then use `what_changed` with `since` = the date of your consolidated texts to see what is new.

## Troubleshooting

| Problem | Fix |
|---|---|
| `SyntaxError` / `node:sqlite` not found | Node is older than 22.13 — upgrade. |
| `LexBG database not found` | Run `npm run build:db` (or set `LEXBG_DB` to the database path). |
| Claude Desktop shows the server as failed | Check the path in the config, use an absolute path to `node`, and look at the MCP log in Settings → Developer. |
| `fetch:parliament` prints HTTP errors for some acts | Re-run the command later; only the failed acts are retried. |
| Search finds nothing for a law | `npm run coverage` — the law's text is probably `missing`. |
| Results warn "later amending act(s) are NOT applied" | Expected for `original` texts. Add a consolidated text or read the changes with `what_changed`. |
