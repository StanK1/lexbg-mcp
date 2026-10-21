/**
 * Polite HTTP client for public government sources: identifies itself, waits between
 * requests, retries with backoff, and never hammers a server.
 */

export const USER_AGENT = 'LexBG/0.1 (+https://github.com/StanK1/LexBG; open-source legal research MCP)';

export interface PoliteFetcherOptions {
  minDelayMs?: number;
  retries?: number;
  timeoutMs?: number;
}

export class PoliteFetcher {
  private last = 0;
  private readonly minDelayMs: number;
  private readonly retries: number;
  private readonly timeoutMs: number;

  constructor(opts: PoliteFetcherOptions = {}) {
    this.minDelayMs = opts.minDelayMs ?? 1200;
    this.retries = opts.retries ?? 2;
    this.timeoutMs = opts.timeoutMs ?? 30000;
  }

  private async wait(): Promise<void> {
    const elapsed = Date.now() - this.last;
    if (elapsed < this.minDelayMs) await sleep(this.minDelayMs - elapsed);
    this.last = Date.now();
  }

  async text(url: string, accept = 'text/html,application/xhtml+xml,*/*', headers: Record<string, string> = {}): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      await this.wait();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': USER_AGENT, Accept: accept, 'Accept-Language': 'bg,en;q=0.5', ...headers },
          redirect: 'follow',
          signal: ctrl.signal,
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (!res.ok) throw new FatalHttpError(`HTTP ${res.status} for ${url}`);
        return await res.text();
      } catch (err) {
        lastError = err;
        if (err instanceof FatalHttpError) throw err;
        if (attempt < this.retries) await sleep((attempt + 1) * 2000);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`Failed to fetch ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  async json<T>(url: string): Promise<T> {
    const body = await this.text(url, 'application/json, text/plain, */*');
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new Error(`Invalid JSON from ${url} (first bytes: ${body.slice(0, 80)})`);
    }
  }
}

export class FatalHttpError extends Error {}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
