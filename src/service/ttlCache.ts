/** Bounded LRU cache with per-entry TTL. */
export class TtlCache<V> {
  private readonly map = new Map<string, { value: V; expires: number }>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(maxEntries: number, ttlMs: number) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  get enabled(): boolean {
    return this.maxEntries > 0 && this.ttlMs > 0;
  }

  get size(): number {
    return this.map.size;
  }

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(key: string, value: V, ttlMs = this.ttlMs): void {
    if (!this.enabled) return;
    this.map.delete(key);
    while (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    this.map.set(key, { value, expires: Date.now() + ttlMs });
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  /** Removes expired entries (called periodically). */
  prune(): void {
    const now = Date.now();
    for (const [k, e] of this.map) if (e.expires <= now) this.map.delete(k);
  }

  values(): V[] {
    return [...this.map.values()].map((e) => e.value);
  }
}
