/**
 * Local filtering forward proxy through which ALL browser traffic flows.
 *
 * - Supports plain HTTP (absolute-form requests) and CONNECT tunnels (HTTPS, WSS).
 * - Resolves every destination itself through {@link SafeResolver} and connects
 *   to the validated address, eliminating DNS-rebinding and private-network access.
 * - Each resolution job gets its own credentials (one browser context = one
 *   session), which provides per-job accounting, byte limits and precise
 *   attribution of blocked requests. Closing a session tears down its sockets.
 * - Listens on loopback only and requires authentication, so it cannot be used
 *   as an open relay by other local processes.
 */
import http from 'node:http';
import net from 'node:net';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import type { Logger } from '../logger.ts';
import type { UrlPolicy } from './urlPolicy.ts';
import { normaliseHostname } from './urlPolicy.ts';
import { DnsResolutionError, EgressPolicyError, type SafeResolver } from './resolver.ts';

export type EgressEventKind = 'policy' | 'dns' | 'connect' | 'limit';

export interface EgressEvent {
  kind: EgressEventKind;
  host: string;
  port: number;
  reason: string;
  at: number;
}

export interface EgressSessionLimits {
  maxBytes: number;
  maxRequests: number;
}

export class EgressSession {
  readonly id: string;
  readonly username: string;
  readonly password: string;
  readonly limits: EgressSessionLimits;
  readonly events: EgressEvent[] = [];
  bytes = 0;
  requests = 0;
  closed = false;
  limitExceeded: string | null = null;
  readonly sockets = new Set<Duplex>();
  readonly passwordDigest: Buffer;

  constructor(limits: EgressSessionLimits) {
    this.id = randomBytes(8).toString('hex');
    this.username = `job-${this.id}`;
    this.password = randomBytes(18).toString('base64url');
    this.passwordDigest = createHash('sha256').update(this.password).digest();
    this.limits = limits;
  }

  record(event: Omit<EgressEvent, 'at'>): void {
    this.events.push({ ...event, at: Date.now() });
    if (this.events.length > 100) this.events.shift();
  }

  /** Most recent event for a host (used to explain browser navigation errors). */
  lastEventFor(host: string): EgressEvent | undefined {
    const h = normaliseHostname(host);
    for (let i = this.events.length - 1; i >= 0; i--) if (this.events[i]!.host === h) return this.events[i];
    return undefined;
  }

  addBytes(n: number): boolean {
    this.bytes += n;
    if (this.bytes > this.limits.maxBytes && !this.limitExceeded) {
      this.limitExceeded = `byte budget of ${this.limits.maxBytes} exceeded`;
    }
    return !this.limitExceeded;
  }
}

export interface EgressProxyOptions {
  resolver: SafeResolver;
  policy: UrlPolicy;
  logger: Logger;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function stripHopByHop(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  const connectionTokens = new Set(
    String(headers.connection ?? '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || connectionTokens.has(lk)) continue;
    out[k] = v;
  }
  return out;
}

function parseAuthority(authority: string): { host: string; port: number } | null {
  const m = /^\[([^\]]+)\]:(\d{1,5})$/.exec(authority) ?? /^([^:]+):(\d{1,5})$/.exec(authority);
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  return { host: normaliseHostname(m[1]!), port };
}

export class EgressProxy {
  private readonly resolver: SafeResolver;
  private readonly policy: UrlPolicy;
  private readonly logger: Logger;
  private readonly connectTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly sessions = new Map<string, EgressSession>();
  private readonly server: http.Server;
  private port = 0;
  /** Counters exposed through metrics. */
  readonly stats = { blocked: 0, tunnels: 0, httpRequests: 0, authFailures: 0 };

  constructor(options: EgressProxyOptions) {
    this.resolver = options.resolver;
    this.policy = options.policy;
    this.logger = options.logger.child({ component: 'egress-proxy' });
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
    this.server = http.createServer();
    this.server.on('request', (req, res) => void this.handleHttp(req, res));
    this.server.on('connect', (req, socket, head) => void this.handleConnect(req, socket, head));
    this.server.on('upgrade', (_req, socket) => {
      socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n');
    });
    this.server.on('clientError', (_err, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      else socket.destroy();
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    this.port = (this.server.address() as net.AddressInfo).port;
    this.logger.debug('egress proxy listening', { port: this.port });
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get activeSessions(): number {
    return this.sessions.size;
  }

  createSession(limits: EgressSessionLimits): EgressSession {
    const s = new EgressSession(limits);
    this.sessions.set(s.username, s);
    return s;
  }

  closeSession(session: EgressSession): void {
    session.closed = true;
    this.sessions.delete(session.username);
    for (const sock of session.sockets) sock.destroy();
    session.sockets.clear();
  }

  async stop(): Promise<void> {
    for (const s of [...this.sessions.values()]) this.closeSession(s);
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private authenticate(header: string | undefined): EgressSession | null {
    if (!header || !header.startsWith('Basic ')) return null;
    let decoded: string;
    try {
      decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    } catch {
      return null;
    }
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    const session = this.sessions.get(decoded.slice(0, idx));
    if (!session || session.closed) return null;
    const given = createHash('sha256')
      .update(decoded.slice(idx + 1))
      .digest();
    return timingSafeEqual(given, session.passwordDigest) ? session : null;
  }

  private block(session: EgressSession, kind: EgressEventKind, host: string, port: number, reason: string): void {
    session.record({ kind, host, port, reason });
    if (kind === 'policy' || kind === 'limit') {
      this.stats.blocked++;
      this.logger.warn('egress blocked', { session: session.id, kind, host, port, reason });
    } else {
      this.logger.debug('egress failure', { session: session.id, kind, host, port, reason });
    }
  }

  /** Validates destination + session budget; returns the pinned address or null after recording. */
  private async admit(
    session: EgressSession,
    host: string,
    port: number,
  ): Promise<{ address: string; status: number } | { address: null; status: number }> {
    if (session.limitExceeded) {
      this.block(session, 'limit', host, port, session.limitExceeded);
      return { address: null, status: 429 };
    }
    session.requests++;
    if (session.requests > session.limits.maxRequests) {
      session.limitExceeded = `request budget of ${session.limits.maxRequests} exceeded`;
      this.block(session, 'limit', host, port, session.limitExceeded);
      return { address: null, status: 429 };
    }
    if (!this.policy.isPortAllowed(port)) {
      this.block(session, 'policy', host, port, `port ${port} is not allowed`);
      return { address: null, status: 403 };
    }
    try {
      const addrs = await this.resolver.resolve(host);
      return { address: addrs[0]!.address, status: 200 };
    } catch (err) {
      if (err instanceof EgressPolicyError) {
        this.block(session, 'policy', host, port, err.reason);
        return { address: null, status: 403 };
      }
      if (err instanceof DnsResolutionError) {
        this.block(session, 'dns', host, port, err.code);
        return { address: null, status: 502 };
      }
      this.block(session, 'connect', host, port, (err as Error).message);
      return { address: null, status: 502 };
    }
  }

  private async handleConnect(req: http.IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    client.on('error', () => client.destroy());
    const session = this.authenticate(req.headers['proxy-authorization']);
    if (!session) {
      this.stats.authFailures++;
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="egress"\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const target = parseAuthority(req.url ?? '');
    if (!target) {
      client.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const admitted = await this.admit(session, target.host, target.port);
    if (!admitted.address || session.closed) {
      const reasonText = admitted.status === 403 ? 'Forbidden' : admitted.status === 429 ? 'Too Many Requests' : 'Bad Gateway';
      client.end(`HTTP/1.1 ${admitted.status} ${reasonText}\r\nX-Egress-Blocked: 1\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    this.stats.tunnels++;
    const upstream = net.connect({ host: admitted.address, port: target.port });
    session.sockets.add(client);
    session.sockets.add(upstream);
    let established = false;
    /** Tears both sides down; before the tunnel is up the client gets a status line instead of a reset. */
    const cleanup = (failureStatus?: string) => {
      clearTimeout(connectTimer);
      session.sockets.delete(client);
      session.sockets.delete(upstream);
      upstream.destroy();
      if (!established && failureStatus && client.writable) {
        client.end(`HTTP/1.1 ${failureStatus}\r\nContent-Length: 0\r\n\r\n`);
      } else {
        client.destroy();
      }
    };
    const connectTimer = setTimeout(() => {
      this.block(session, 'connect', target.host, target.port, 'connect timeout');
      cleanup('504 Gateway Timeout');
    }, this.connectTimeoutMs);
    upstream.once('connect', () => {
      established = true;
      clearTimeout(connectTimer);
      upstream.setTimeout(this.idleTimeoutMs, () => cleanup());
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      const count = (chunk: Buffer) => {
        if (!session.addBytes(chunk.length)) {
          this.block(session, 'limit', target.host, target.port, session.limitExceeded ?? 'limit');
          cleanup();
        }
      };
      upstream.on('data', count);
      client.on('data', count);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.once('error', (err: NodeJS.ErrnoException) => {
      this.block(session, 'connect', target.host, target.port, err.code ?? err.message);
      cleanup('502 Bad Gateway');
    });
    upstream.once('close', () => cleanup('502 Bad Gateway'));
    client.once('close', () => cleanup());
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const session = this.authenticate(req.headers['proxy-authorization']);
    if (!session) {
      this.stats.authFailures++;
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="egress"', 'Content-Length': '0' });
      res.end();
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '');
      if (url.protocol !== 'http:') throw new Error('scheme');
    } catch {
      res.writeHead(400, { 'Content-Length': '0' });
      res.end();
      return;
    }
    const host = normaliseHostname(url.hostname);
    const port = url.port ? Number(url.port) : 80;
    const verdict = this.policy.checkNetworkUrl(url);
    if (!verdict.allowed) {
      this.block(session, 'policy', host, port, verdict.reason);
      res.writeHead(403, { 'X-Egress-Blocked': '1', 'Content-Type': 'text/plain' });
      res.end('Blocked by egress policy');
      return;
    }
    const admitted = await this.admit(session, host, port);
    if (!admitted.address || session.closed) {
      res.writeHead(admitted.status, { 'X-Egress-Blocked': '1', 'Content-Type': 'text/plain' });
      res.end('Blocked by egress policy');
      return;
    }
    this.stats.httpRequests++;
    const headers = stripHopByHop(req.headers);
    headers.host = url.host;
    const upstream = http.request({
      host: admitted.address,
      port,
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers,
      setHost: false,
      timeout: this.idleTimeoutMs,
    });
    session.sockets.add(upstream as unknown as Duplex);
    const done = () => session.sockets.delete(upstream as unknown as Duplex);
    upstream.on('response', (up) => {
      const outHeaders = stripHopByHop(up.headers);
      // Upstream servers must not be able to spoof the proxy's own signalling headers.
      for (const k of Object.keys(outHeaders)) if (k.toLowerCase().startsWith('x-egress-')) delete outHeaders[k];
      res.writeHead(up.statusCode ?? 502, up.statusMessage, outHeaders);
      up.on('data', (chunk: Buffer) => {
        if (!session.addBytes(chunk.length)) {
          this.block(session, 'limit', host, port, session.limitExceeded ?? 'limit');
          upstream.destroy();
          res.destroy();
        }
      });
      up.pipe(res);
      up.on('end', done);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', (err: NodeJS.ErrnoException) => {
      done();
      this.block(session, 'connect', host, port, err.code ?? err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'X-Egress-Error': err.code ?? 'error', 'Content-Type': 'text/plain' });
        res.end('Upstream connection failed');
      } else {
        res.destroy();
      }
    });
    req.on('data', (chunk: Buffer) => session.addBytes(chunk.length));
    req.pipe(upstream);
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
      done();
    });
  }
}
