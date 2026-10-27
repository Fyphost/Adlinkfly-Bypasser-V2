/** Token-bucket rate limiter keyed by API key or client IP. */

export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until a token becomes available (0 when allowed). */
  retryAfter: number;
  /** Seconds until the bucket is full again. */
  reset: number;
}

interface Bucket {
  tokens: number;
  updated: number;
}

export class RateLimiter {
  private readonly ratePerMs: number;
  private readonly burst: number;
  private readonly buckets = new Map<string, Bucket>();
  private readonly maxKeys: number;

  constructor(options: { perMinute: number; burst: number; maxKeys?: number }) {
    this.ratePerMs = options.perMinute / 60_000;
    this.burst = Math.max(1, options.burst);
    this.maxKeys = options.maxKeys ?? 100_000;
  }

  take(key: string, cost = 1, now = Date.now()): RateDecision {
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.prune(now);
      b = { tokens: this.burst, updated: now };
      this.buckets.set(key, b);
    } else {
      b.tokens = Math.min(this.burst, b.tokens + (now - b.updated) * this.ratePerMs);
      b.updated = now;
    }
    const allowed = b.tokens >= cost;
    if (allowed) b.tokens -= cost;
    const reset = Math.ceil((this.burst - b.tokens) / this.ratePerMs / 1000);
    if (allowed) return { allowed: true, limit: this.burst, remaining: Math.floor(b.tokens), retryAfter: 0, reset };
    const retryAfter = Math.max(1, Math.ceil((cost - b.tokens) / this.ratePerMs / 1000));
    return { allowed: false, limit: this.burst, remaining: 0, retryAfter, reset };
  }

  /** Peeks whether a key is currently exhausted without consuming tokens. */
  isExhausted(key: string, now = Date.now()): boolean {
    const b = this.buckets.get(key);
    if (!b) return false;
    return Math.min(this.burst, b.tokens + (now - b.updated) * this.ratePerMs) < 1;
  }

  /** Drops buckets that are full again (they carry no state). */
  prune(now = Date.now()): void {
    for (const [k, b] of this.buckets) {
      if (b.tokens + (now - b.updated) * this.ratePerMs >= this.burst) this.buckets.delete(k);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

export function rateHeaders(d: RateDecision): Record<string, string> {
  const h: Record<string, string> = {
    'RateLimit-Limit': String(d.limit),
    'RateLimit-Remaining': String(d.remaining),
    'RateLimit-Reset': String(d.reset),
  };
  if (!d.allowed) h['Retry-After'] = String(d.retryAfter);
  return h;
}
