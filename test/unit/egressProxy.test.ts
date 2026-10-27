import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { EgressProxy } from '../../src/security/egressProxy.ts';
import { SafeResolver } from '../../src/security/resolver.ts';
import { UrlPolicy } from '../../src/security/urlPolicy.ts';
import { silentLogger } from '../../src/logger.ts';

let upstream: http.Server;
let upstreamPort = 0;
let proxy: EgressProxy;

const policy = new UrlPolicy({ allowedPorts: 'any', allowPrivateCidrs: ['127.0.0.1/32'], domainDenylist: [] });
const resolver = new SafeResolver({
  policy,
  cacheTtlMs: 0,
  lookupAll: async (h) => {
    if (h === 'site.test') return [{ address: '127.0.0.1', family: 4 }];
    if (h === 'meta.test') return [{ address: '169.254.169.254', family: 4 }];
    const e = new Error('ENOTFOUND') as NodeJS.ErrnoException;
    e.code = 'ENOTFOUND';
    throw e;
  },
});

before(async () => {
  upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'x-egress-blocked': 'spoofed' });
    res.end(`host=${req.headers.host} path=${req.url} proxyauth=${req.headers['proxy-authorization'] ?? 'none'}`);
  });
  upstream.on('connect', () => undefined);
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  upstreamPort = (upstream.address() as AddressInfo).port;
  proxy = new EgressProxy({ resolver, policy, logger: silentLogger });
  await proxy.start();
});

after(async () => {
  await proxy.stop();
  await new Promise<void>((r) => upstream.close(() => r()));
});

function viaProxy(target: string, auth?: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  const p = new URL(proxy.url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: p.hostname,
        port: p.port,
        method: 'GET',
        path: target,
        headers: auth ? { 'proxy-authorization': `Basic ${Buffer.from(auth).toString('base64')}` } : {},
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function connectViaProxy(authority: string, auth?: string): Promise<string> {
  const p = new URL(proxy.url);
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(p.port), p.hostname, () => {
      sock.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth ? `Proxy-Authorization: Basic ${Buffer.from(auth).toString('base64')}\r\n` : ''}\r\n`,
      );
    });
    let data = '';
    sock.on('data', (c) => {
      data += c.toString();
      if (data.includes('\r\n\r\n')) {
        resolve(data.split('\r\n')[0]!);
        sock.destroy();
      }
    });
    sock.on('error', reject);
  });
}

test('requires per-session proxy credentials', async () => {
  const r = await viaProxy(`http://site.test:${upstreamPort}/x`);
  assert.equal(r.status, 407);
  const bad = await viaProxy(`http://site.test:${upstreamPort}/x`, 'job-nope:wrong');
  assert.equal(bad.status, 407);
  assert.match(await connectViaProxy(`site.test:${upstreamPort}`), /407/);
});

test('forwards allowed HTTP requests to the pinned address without leaking proxy credentials', async () => {
  const s = proxy.createSession({ maxBytes: 1_000_000, maxRequests: 100 });
  const r = await viaProxy(`http://site.test:${upstreamPort}/hello?q=1`, `${s.username}:${s.password}`);
  assert.equal(r.status, 200);
  assert.match(r.body, new RegExp(`host=site.test:${upstreamPort} path=/hello\\?q=1 proxyauth=none`));
  assert.equal(r.headers['x-egress-blocked'], undefined, 'upstream must not spoof proxy headers');
  proxy.closeSession(s);
});

test('blocks private destinations for HTTP and CONNECT and records the reason', async () => {
  const s = proxy.createSession({ maxBytes: 1_000_000, maxRequests: 100 });
  const auth = `${s.username}:${s.password}`;
  const r = await viaProxy('http://meta.test/latest/meta-data', auth);
  assert.equal(r.status, 403);
  assert.equal(r.headers['x-egress-blocked'], '1');
  assert.match(await connectViaProxy('meta.test:443', auth), /403/);
  assert.match(await connectViaProxy('10.0.0.1:443', auth), /403/);
  assert.match(await connectViaProxy('unknown.test:443', auth), /502/);
  assert.equal(s.lastEventFor('meta.test')?.kind, 'policy');
  assert.equal(s.lastEventFor('unknown.test')?.kind, 'dns');
  proxy.closeSession(s);
});

test('enforces the per-session request budget and rejects closed sessions', async () => {
  const s = proxy.createSession({ maxBytes: 1_000_000, maxRequests: 2 });
  const auth = `${s.username}:${s.password}`;
  assert.equal((await viaProxy(`http://site.test:${upstreamPort}/1`, auth)).status, 200);
  assert.equal((await viaProxy(`http://site.test:${upstreamPort}/2`, auth)).status, 200);
  assert.equal((await viaProxy(`http://site.test:${upstreamPort}/3`, auth)).status, 429);
  proxy.closeSession(s);
  assert.equal((await viaProxy(`http://site.test:${upstreamPort}/4`, auth)).status, 407);
});

test('propagates an upstream reset mid-body instead of leaving the response hanging', async () => {
  const broken = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-length': '1000', 'content-type': 'text/plain' });
    res.write('partial-body!');
    setTimeout(() => res.socket?.destroy(), 50);
  });
  await new Promise<void>((r) => broken.listen(0, '127.0.0.1', () => r()));
  const port = (broken.address() as AddressInfo).port;
  const s = proxy.createSession({ maxBytes: 1_000_000, maxRequests: 100 });
  const p = new URL(proxy.url);
  try {
    const outcome = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve('hung'), 3000);
      const req = http.request(
        {
          host: p.hostname,
          port: p.port,
          path: `http://site.test:${port}/x`,
          headers: { 'proxy-authorization': `Basic ${Buffer.from(`${s.username}:${s.password}`).toString('base64')}` },
        },
        (res) => {
          res.on('data', () => undefined);
          res.on('end', () => {
            clearTimeout(timer);
            resolve(res.complete ? 'complete' : 'aborted');
          });
          res.on('error', () => {
            clearTimeout(timer);
            resolve('aborted');
          });
          res.on('aborted', () => {
            clearTimeout(timer);
            resolve('aborted');
          });
        },
      );
      req.on('error', () => {
        clearTimeout(timer);
        resolve('aborted');
      });
      req.end();
    });
    assert.equal(outcome, 'aborted');
  } finally {
    proxy.closeSession(s);
    broken.close();
  }
});

test('establishes CONNECT tunnels to allowed destinations', async () => {
  const s = proxy.createSession({ maxBytes: 1_000_000, maxRequests: 100 });
  assert.match(await connectViaProxy(`site.test:${upstreamPort}`, `${s.username}:${s.password}`), /200 Connection Established/);
  proxy.closeSession(s);
});
