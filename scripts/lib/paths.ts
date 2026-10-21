import * as path from 'node:path';
import { findRoot } from '../../src/registry.js';

export const ROOT = findRoot();

/** Raw downloads live in data/raw (gitignored). Tests point LEXBG_RAW at fixtures/raw. */
export function rawDir(): string {
  return process.env.LEXBG_RAW ? path.resolve(process.env.LEXBG_RAW) : path.join(ROOT, 'data', 'raw');
}

export const paths = {
  get parliament() { return path.join(rawDir(), 'parliament'); },
  get parliamentActs() { return path.join(rawDir(), 'parliament', 'acts'); },
  get catalog() { return path.join(rawDir(), 'parliament', 'catalog.json'); },
  get eurlex() { return path.join(rawDir(), 'eurlex'); },
  get manual() {
    return process.env.LEXBG_MANUAL ? path.resolve(process.env.LEXBG_MANUAL) : path.join(ROOT, 'data', 'manual');
  },
};

export function argValue(name: string): string | undefined {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  const eq = args.find(a => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

export function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
}
