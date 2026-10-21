#!/usr/bin/env node
/**
 * LexBG MCP server (stdio). Point your MCP client at:  node /path/to/LexBG/dist/src/index.js
 * Environment: LEXBG_DB (database path), LEXBG_ROOT (repository folder).
 */
import './quiet.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { defaultDbPath, openDb } from './db.js';
import { loadRegistry } from './registry.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const db = openDb(defaultDbPath(), { readOnly: true });
  const server = createServer(db, loadRegistry());
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel — log to stderr only.
  console.error(`LexBG MCP server running (database: ${defaultDbPath()})`);
}

main().catch(err => {
  console.error(`LexBG failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
