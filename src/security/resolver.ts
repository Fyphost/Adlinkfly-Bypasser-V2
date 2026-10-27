/**
 * DNS resolution with SSRF validation and IP pinning.
 *
 * Every address a host name resolves to must be public (or explicitly
 * exempted). The validated address is then handed to the socket layer through
 * a custom `lookup` function, so the address that was checked is exactly the
 * address that is connected to (no DNS-rebinding window).
 */
import dns from 'node:dns';
import type { LookupFunction } from 'node:net';
import type { UrlPolicy } from './urlPolicy.ts';
import { normaliseHostname } from './urlPolicy.ts';
import { parseIp } from './ip.ts';

export interface LookupAddress {
  address: string;
  family: 4 | 6;
}

export type LookupAllFn = (hostname: string) => Promise<LookupAddress[]>;

export class EgressPolicyError extends Error {
  readonly host: string;
  readonly reason: string;
  constructor(host: string, reason: string) {
    super(`Egress to ${host} blocked: ${reason}`);
    this.name = 'EgressPolicyError';
    this.host = host;
    this.reason = reason;
  }
}

export class DnsResolutionError extends Error {
  readonly host: string;
  readonly code: string;
  constructor(host: string, code: string) {
    super(`DNS resolution failed for ${host} (${code})`);
    this.name = 'DnsResolutionError';
    this.host = host;
    this.code = code;
  }
}

export const systemLookupAll: LookupAllFn = async (hostname) => {
  const res = await dns.promises.lookup(hostname, { all: true, order: 'ipv4first' });
  return res.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

interface CacheEntry {
  expires: number;
  addresses?: LookupAddress[];
  error?: Error;
}

export interface SafeResolverOptions {
  policy: UrlPolicy;
  lookupAll?: LookupAllFn;
  cacheTtlMs: number;
  maxCacheEntries?: number;
}

export class SafeResolver {
  private readonly policy: UrlPolicy;
  private readonly lookupAll: LookupAllFn;
  private readonly ttl: number;
  private readonly maxEntries: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<LookupAddress[]>>();

  constructor(options: SafeResolverOptions) {
    this.policy = options.policy;
    this.lookupAll = options.lookupAll ?? systemLookupAll;
    this.ttl = options.cacheTtlMs;
    this.maxEntries = options.maxCacheEntries ?? 10_000;
  }

  /** Resolves and validates a host. Throws EgressPolicyError or DnsResolutionError. */
  async resolve(rawHost: string): Promise<LookupAddress[]> {
    const host = normaliseHostname(rawHost);
    const literal = parseIp(host);
    if (literal) {
      const verdict = this.policy.checkAddress(host);
      if (!verdict.allowed) throw new EgressPolicyError(host, verdict.reason);
      return [{ address: host, family: literal.version }];
    }
    const hostVerdict = this.policy.checkHost(host);
    if (!hostVerdict.allowed) throw new EgressPolicyError(host, hostVerdict.reason);

    const now = Date.now();
    const cached = this.cache.get(host);
    if (cached && cached.expires > now) {
      if (cached.error) throw cached.error;
      return cached.addresses!;
    }
    const pending = this.inflight.get(host);
    if (pending) return pending;

    const p = this.doResolve(host).finally(() => this.inflight.delete(host));
    this.inflight.set(host, p);
    return p;
  }

  private async doResolve(host: string): Promise<LookupAddress[]> {
    let addresses: LookupAddress[];
    try {
      addresses = await this.lookupAll(host);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'EDNS';
      const error = new DnsResolutionError(host, code);
      this.store(host, { expires: Date.now() + Math.min(this.ttl, 5_000), error });
      throw error;
    }
    if (addresses.length === 0) {
      const error = new DnsResolutionError(host, 'ENODATA');
      this.store(host, { expires: Date.now() + Math.min(this.ttl, 5_000), error });
      throw error;
    }
    // Reject the host if ANY address is non-public: mixed answers are a classic rebinding trick.
    for (const a of addresses) {
      const verdict = this.policy.checkAddress(a.address);
      if (!verdict.allowed) {
        const error = new EgressPolicyError(host, `resolves to a forbidden address (${verdict.reason})`);
        this.store(host, { expires: Date.now() + this.ttl, error });
        throw error;
      }
    }
    this.store(host, { expires: Date.now() + this.ttl, addresses });
    return addresses;
  }

  private store(host: string, entry: CacheEntry): void {
    if (this.ttl <= 0) return;
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(host, entry);
  }

  /** A Node `lookup` implementation that only ever yields validated addresses. */
  lookupFunction(): LookupFunction {
    return ((hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
      this.resolve(hostname).then(
        (addrs) => {
          if (options && options.all) callback(null, addrs);
          else callback(null, addrs[0]!.address, addrs[0]!.family);
        },
        (err: unknown) => callback(err),
      );
    }) as unknown as LookupFunction;
  }

  clearCache(): void {
    this.cache.clear();
  }
}
