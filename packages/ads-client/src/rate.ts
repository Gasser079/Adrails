// @adrails/ads-client/rate — Rate Shield primitives: exponential backoff with
// jitter, per-customer keyword-planning gate (1 QPS), and a pluggable KV cache.
export interface RetryPolicy {
  maxAttempts: number;
  baseMs: number;
  maxMs: number;
  jitterRatio: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 4, baseMs: 250, maxMs: 8000, jitterRatio: 0.25 };

export function backoffMs(attempt: number, policy: RetryPolicy, rand: () => number = Math.random): number {
  const exp = Math.min(policy.maxMs, policy.baseMs * 2 ** attempt);
  const jitter = exp * policy.jitterRatio * (rand() * 2 - 1);
  return Math.max(0, Math.round(exp + jitter));
}

export async function retryWithBackoff<T>(fn: (attempt: number) => Promise<T>, opts: {
  policy?: RetryPolicy;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
} = {}): Promise<T> {
  const policy = opts.policy ?? DEFAULT_RETRY;
  const shouldRetry = opts.shouldRetry ?? (() => true);
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let last: unknown;
  for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      last = err;
      if (attempt >= policy.maxAttempts - 1 || !shouldRetry(err, attempt)) throw err;
      await sleep(backoffMs(attempt, policy));
    }
  }
  throw last;
}

/**
 * Per-customer FIFO gate for keyword-planning endpoints (Google enforces 1 QPS
 * per customer on generateKeyword*). Serializes calls per customer id.
 */
export class PerCustomerGate {
  private readonly tails = new Map<string, Promise<void>>();
  public async run<T>(customerId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(customerId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    this.tails.set(customerId, prev.then(() => gate));
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(customerId) === gate) this.tails.delete(customerId);
    }
  }
}

export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

export class KvResponseCache {
  constructor(private readonly kv: KvLike | null, private readonly prefix = "adrails:cache:") {}
  public key(parts: Array<string | number>): string {
    return this.prefix + parts.join(":");
  }
  public async get<T>(key: string): Promise<T | null> {
    if (!this.kv) return null;
    const raw = await this.kv.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }
  public async put(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!this.kv) return;
    await this.kv.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds });
  }
}
