#!/usr/bin/env node
/**
 * LexBG MCP server (stdio).
 *
 *   npx -y https://github.com/StanK1/lexbg-mcp/releases/latest/download/lexbg.tgz
 *   node /path/to/LexBG/dist/src/index.js
 *
 * The server answers the MCP handshake immediately. On first run it downloads the weekly
 * prebuilt database (~1 min at most) — tool calls made meanwhile simply wait for it.
 * Environment: LEXBG_DB, LEXBG_HOME, LEXBG_DATA_URL, LEXBG_OFFLINE=1 (see src/data.ts).
 */
import './quiet.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDb } from './db.js';
import { resolveDatabase } from './data.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const db = resolveDatabase().then(r => {
    // stdout is the MCP channel — log to stderr only.
    console.error(`[lexbg] database: ${r.file} (${r.source})`);
    return openDb(r.file, { readOnly: true });
  });
  db.catch(err => console.error(`[lexbg] ${err instanceof Error ? err.message : String(err)}`));
  const server = createServer(db);
  await server.connect(new StdioServerTransport());
  console.error('[lexbg] MCP server running');
}

main().catch(err => {
  console.error(`LexBG failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
