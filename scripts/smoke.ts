#!/usr/bin/env tsx
/**
 * Smoke test: start the real stdio server (dist/src/index.js) as a child process, the way
 * Claude Desktop does, list its tools and call `about`.   npm run build && npm run smoke
 */
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT } from './lib/paths.js';

async function main(): Promise<void> {
  const server = path.join(ROOT, 'dist', 'src', 'index.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [server], env: { ...process.env } as Record<string, string> });
  const client = new Client({ name: 'lexbg-smoke', version: '0.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log(`Connected. ${tools.length} tools: ${tools.map(t => t.name).join(', ')}`);
  const res = await client.callTool({ name: 'about', arguments: {} });
  const about = JSON.parse((res.content as Array<{ text: string }>)[0].text);
  console.log(`Database built ${about.built_at}: ${about.provisions} provisions, ${about.promulgated_acts} acts, ${about.amendment_links} amendment links.`);
  console.log(`Bulgarian laws: ${JSON.stringify(about.bulgarian_laws)}`);
  await client.close();
  if (tools.length < 10) throw new Error('expected 10 tools');
  console.log('LexBG is ready to use from your MCP client.');
}

main().catch(err => {
  console.error(`Smoke test failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
