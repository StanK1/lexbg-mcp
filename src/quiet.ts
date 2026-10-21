/**
 * node:sqlite prints an ExperimentalWarning on first use. It goes to stderr (harmless for MCP
 * stdio), but we silence just that one warning to keep client logs clean.
 * Import this module before anything that touches node:sqlite.
 */
const original = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning?.message ?? '';
  if (text.includes('SQLite is an experimental feature')) return;
  return (original as (...a: unknown[]) => void)(warning, ...args);
}) as typeof process.emitWarning;

export {};
