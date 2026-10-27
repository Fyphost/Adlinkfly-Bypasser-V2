/**
 * IP address parsing and classification used for SSRF protection.
 *
 * Only globally routable unicast addresses are considered public. Addresses
 * embedding IPv4 (IPv4-mapped, NAT64, 6to4) are classified by their embedded
 * IPv4 address so that e.g. `::ffff:127.0.0.1` cannot be used to reach
 * loopback.
 */

export type IpVersion = 4 | 6;

export interface ParsedIp {
  version: IpVersion;
  value: bigint;
}

export interface Cidr {
  version: IpVersion;
  base: bigint;
  prefix: number;
  text: string;
}

const V4_DEC = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

export function parseIPv4(input: string): bigint | null {
  const parts = input.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const p of parts) {
    if (!V4_DEC.test(p)) return null;
    value = (value << 8n) | BigInt(Number(p));
  }
  return value;
}

export function parseIPv6(input: string): bigint | null {
  let s = input;
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (s.includes('%')) return null; // zone identifiers are never valid targets
  if (!/^[0-9a-fA-F:.]+$/.test(s) || !s.includes(':')) return null;

  // Handle an embedded dotted IPv4 suffix (e.g. ::ffff:1.2.3.4).
  let tailWords: number[] = [];
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (v4 === null) return null;
    tailWords = [Number((v4 >> 16n) & 0xffffn), Number(v4 & 0xffffn)];
    s = s.slice(0, lastColon + 1);
    // Keep the trailing colon only when it is part of a "::" sequence.
    if (!s.endsWith('::')) s = s.slice(0, -1);
  }

  const doubleColon = s.indexOf('::');
  if (doubleColon !== s.lastIndexOf('::')) return null;

  const parseGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  let words: number[];
  if (doubleColon >= 0) {
    const head = parseGroups(s.slice(0, doubleColon));
    const rest = parseGroups(s.slice(doubleColon + 2));
    if (!head || !rest) return null;
    const fill = 8 - head.length - rest.length - tailWords.length;
    if (fill < 1) return null;
    words = [...head, ...new Array<number>(fill).fill(0), ...rest, ...tailWords];
  } else {
    const all = parseGroups(s);
    if (!all) return null;
    words = [...all, ...tailWords];
  }
  if (words.length !== 8) return null;
  let value = 0n;
  for (const w of words) value = (value << 16n) | BigInt(w);
  return value;
}

export function parseIp(input: string): ParsedIp | null {
  const v4 = parseIPv4(input);
  if (v4 !== null) return { version: 4, value: v4 };
  const v6 = parseIPv6(input);
  if (v6 !== null) return { version: 6, value: v6 };
  return null;
}

export function parseCidr(input: string): Cidr | null {
  const [addr, prefixText, extra] = input.trim().split('/');
  if (extra !== undefined || !addr) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  const max = ip.version === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? max : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  const bits = BigInt(max);
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << (bits - BigInt(prefix));
  return { version: ip.version, base: ip.value & mask, prefix, text: input.trim() };
}

export function cidrContains(cidr: Cidr, ip: ParsedIp): boolean {
  if (cidr.version !== ip.version) return false;
  const bits = cidr.version === 4 ? 32n : 128n;
  const mask = cidr.prefix === 0 ? 0n : ((1n << BigInt(cidr.prefix)) - 1n) << (bits - BigInt(cidr.prefix));
  return (ip.value & mask) === cidr.base;
}

function table(entries: Array<[string, string]>): Array<{ cidr: Cidr; reason: string }> {
  return entries.map(([c, reason]) => {
    const cidr = parseCidr(c);
    if (!cidr) throw new Error(`invalid built-in CIDR ${c}`);
    return { cidr, reason };
  });
}

const RESERVED_V4 = table([
  ['0.0.0.0/8', 'this-network'],
  ['10.0.0.0/8', 'private'],
  ['100.64.0.0/10', 'carrier-grade-nat'],
  ['127.0.0.0/8', 'loopback'],
  ['169.254.0.0/16', 'link-local'],
  ['172.16.0.0/12', 'private'],
  ['192.0.0.0/24', 'ietf-protocol'],
  ['192.0.2.0/24', 'documentation'],
  ['192.31.196.0/24', 'as112'],
  ['192.52.193.0/24', 'amt'],
  ['192.88.99.0/24', '6to4-relay'],
  ['192.168.0.0/16', 'private'],
  ['192.175.48.0/24', 'as112'],
  ['198.18.0.0/15', 'benchmarking'],
  ['198.51.100.0/24', 'documentation'],
  ['203.0.113.0/24', 'documentation'],
  ['224.0.0.0/4', 'multicast'],
  ['240.0.0.0/4', 'reserved'],
]);

const RESERVED_V6 = table([
  ['::/128', 'unspecified'],
  ['::1/128', 'loopback'],
  ['::/96', 'ipv4-compatible'],
  ['64:ff9b:1::/48', 'nat64-local'],
  ['100::/64', 'discard'],
  ['2001::/23', 'ietf-protocol'],
  ['2001:db8::/32', 'documentation'],
  ['3fff::/20', 'documentation'],
  ['5f00::/16', 'srv6'],
  ['fc00::/7', 'unique-local'],
  ['fe80::/10', 'link-local'],
  ['fec0::/10', 'site-local'],
  ['ff00::/8', 'multicast'],
]);

const V4_MAPPED = parseCidr('::ffff:0:0/96')!;
const NAT64 = parseCidr('64:ff9b::/96')!;
const SIX_TO_FOUR = parseCidr('2002::/16')!;
const GLOBAL_UNICAST = parseCidr('2000::/3')!;

export interface IpClassification {
  public: boolean;
  /** Why the address is not public (undefined for public addresses). */
  reason?: string;
  /** Canonical textual form. */
  address: string;
}

export function formatIp(ip: ParsedIp): string {
  if (ip.version === 4) {
    const v = ip.value;
    return [24n, 16n, 8n, 0n].map((s) => String((v >> s) & 0xffn)).join('.');
  }
  const words: number[] = [];
  for (let i = 7; i >= 0; i--) words.push(Number((ip.value >> BigInt(i * 16)) & 0xffffn));
  // RFC 5952: compress the longest run (length >= 2) of zero groups.
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (words[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && words[j] === 0) j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = words.map((w) => w.toString(16));
  if (bestLen < 2) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLen).join(':')}`;
}

function classifyV4(value: bigint): string | undefined {
  const ip: ParsedIp = { version: 4, value };
  for (const { cidr, reason } of RESERVED_V4) if (cidrContains(cidr, ip)) return reason;
  return undefined;
}

/** Classifies an IP address string. Unparseable input is treated as non-public. */
export function classifyIp(address: string): IpClassification {
  const ip = parseIp(address);
  if (!ip) return { public: false, reason: 'unparseable', address };
  const text = formatIp(ip);
  if (ip.version === 4) {
    const reason = classifyV4(ip.value);
    return reason ? { public: false, reason, address: text } : { public: true, address: text };
  }
  if (cidrContains(V4_MAPPED, ip) || cidrContains(NAT64, ip)) {
    const reason = classifyV4(ip.value & 0xffffffffn);
    return reason ? { public: false, reason: `embedded-ipv4-${reason}`, address: text } : { public: true, address: text };
  }
  if (cidrContains(SIX_TO_FOUR, ip)) {
    const reason = classifyV4((ip.value >> 80n) & 0xffffffffn);
    return reason ? { public: false, reason: `6to4-${reason}`, address: text } : { public: true, address: text };
  }
  for (const { cidr, reason } of RESERVED_V6) if (cidrContains(cidr, ip)) return { public: false, reason, address: text };
  if (!cidrContains(GLOBAL_UNICAST, ip)) return { public: false, reason: 'not-global-unicast', address: text };
  return { public: true, address: text };
}

/** A set of CIDRs explicitly exempted from the private-network block (testing / trusted internal targets). */
export class CidrSet {
  private readonly cidrs: Cidr[];

  constructor(cidrs: Iterable<string>) {
    this.cidrs = [];
    for (const c of cidrs) {
      const parsed = parseCidr(c);
      if (!parsed) throw new Error(`Invalid CIDR: ${c}`);
      this.cidrs.push(parsed);
    }
  }

  get size(): number {
    return this.cidrs.length;
  }

  contains(address: string): boolean {
    const ip = parseIp(address);
    if (!ip) return false;
    return this.cidrs.some((c) => cidrContains(c, ip));
  }
}

export function isIpLiteral(host: string): boolean {
  return parseIp(host) !== null;
}
