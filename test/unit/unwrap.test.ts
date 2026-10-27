import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { decodeTargetValue, stripTrackingParams, unwrapGenericParam, unwrapKnownWrapper } from '../../src/extraction/unwrap.ts';
import { finalizeDestination } from '../../src/extraction/destination.ts';
import { SafeHttpClient, followRedirectors } from '../../src/extraction/redirectFollower.ts';
import { SafeResolver } from '../../src/security/resolver.ts';
import { UrlPolicy } from '../../src/security/urlPolicy.ts';
import { AppError } from '../../src/errors.ts';

test('unwraps well-known redirect wrappers locally', () => {
  assert.equal(unwrapKnownWrapper('https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fa&sa=D'), 'https://example.com/a');
  assert.equal(unwrapKnownWrapper('https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2F&h=x'), 'https://example.com/');
  assert.equal(unwrapKnownWrapper('https://www.youtube.com/redirect?q=https://example.com/v'), 'https://example.com/v');
  assert.equal(unwrapKnownWrapper('https://href.li/?https://example.com/x'), 'https://example.com/x');
  assert.equal(unwrapKnownWrapper('https://example.com/url?q=https://other.example/'), null);
  assert.equal(unwrapKnownWrapper('https://www.google.com/search?q=https://example.com'), null);
});

test('decodes percent-encoded and base64 targets', () => {
  const b64 = Buffer.from('https://example.com/file?id=7').toString('base64');
  assert.equal(decodeTargetValue(b64), 'https://example.com/file?id=7');
  assert.equal(decodeTargetValue(b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')), 'https://example.com/file?id=7');
  assert.equal(decodeTargetValue('https%253A%252F%252Fexample.com%252F'), 'https://example.com/');
  assert.equal(decodeTargetValue('not-a-url'), null);
  assert.equal(decodeTargetValue(Buffer.from('javascript:alert(1)').toString('base64')), null);
});

test('generic ?url= unwrapping', () => {
  assert.equal(
    unwrapGenericParam(`https://safelink.example/go?url=${Buffer.from('https://dest.example/').toString('base64')}`),
    'https://dest.example/',
  );
  assert.equal(unwrapGenericParam('https://safelink.example/go?id=5'), null);
});

test('strips only well-known tracking parameters', () => {
  assert.equal(stripTrackingParams('https://e.com/p?id=1&utm_source=x&utm_medium=y&fbclid=z#top'), 'https://e.com/p?id=1#top');
  assert.equal(stripTrackingParams('https://e.com/p?utm_campaign=x'), 'https://e.com/p');
  assert.equal(stripTrackingParams('https://e.com/p?q=1&ref=abc'), 'https://e.com/p?q=1&ref=abc');
});

test('finalizeDestination peels wrappers, applies flow-host unwrapping, strips tracking and enforces the deny-list', async () => {
  const opts = {
    stripTracking: true,
    followTrackingRedirects: false,
    maxRedirectHops: 0,
    destinationDenylist: ['blocked.example'],
    isFlowHost: (h: string) => h === 'blog.example',
  };
  const r = await finalizeDestination('https://www.google.com/url?q=https%3A%2F%2Fdest.example%2Fa%3Futm_source%3Dx%26k%3D1', opts);
  assert.equal(r.url, 'https://dest.example/a?k=1');
  assert.equal(r.unwrapped.length, 1);
  const flow = await finalizeDestination('https://blog.example/out?link=https%3A%2F%2Fdest.example%2Fz', opts);
  assert.equal(flow.url, 'https://dest.example/z');
  const notFlow = await finalizeDestination('https://site.example/login?redirect=https%3A%2F%2Fother.example', opts);
  assert.equal(notFlow.url, 'https://site.example/login?redirect=https%3A%2F%2Fother.example');
  await assert.rejects(
    finalizeDestination('https://sub.blocked.example/x', opts),
    (e: unknown) => e instanceof AppError && e.code === 'DESTINATION_NOT_ALLOWED',
  );
  await assert.rejects(
    finalizeDestination('ftp://x.example/', opts),
    (e: unknown) => e instanceof AppError && e.code === 'UNEXPECTED_PAGE',
  );
});

test('follows redirector hops over SSRF-safe HTTP without requesting the final destination', async () => {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.headers.host}${req.url}`);
    if (req.url === '/a') res.writeHead(301, { location: '/b' });
    else if (req.url === '/b') res.writeHead(302, { location: 'https://final.example/page?x=1' });
    else res.writeHead(200);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  const policy = new UrlPolicy({ allowedPorts: 'any', allowPrivateCidrs: ['127.0.0.1/32'], domainDenylist: [] });
  const resolver = new SafeResolver({ policy, cacheTtlMs: 0, lookupAll: async () => [{ address: '127.0.0.1', family: 4 }] });
  const client = new SafeHttpClient({ resolver, policy });
  try {
    const r = await followRedirectors(`http://redir.test:${port}/a`, client, { maxHops: 5, isRedirector: (h) => h === 'redir.test' });
    assert.equal(r.url, 'https://final.example/page?x=1');
    assert.equal(r.hops.length, 2);
    assert.deepEqual(seen, [`HEAD redir.test:${port}/a`, `HEAD redir.test:${port}/b`]);
    const blockedPolicy = new UrlPolicy({ allowedPorts: 'any', allowPrivateCidrs: [], domainDenylist: [] });
    const blocked = new SafeHttpClient({
      resolver: new SafeResolver({ policy: blockedPolicy, cacheTtlMs: 0, lookupAll: async () => [{ address: '127.0.0.1', family: 4 }] }),
      policy: blockedPolicy,
    });
    const r2 = await followRedirectors(`http://redir.test:${port}/a`, blocked, { maxHops: 5, isRedirector: () => true });
    assert.equal(r2.url, `http://redir.test:${port}/a`, 'private redirector address must not be contacted');
    seen.length = 0;
    const aborted = new AbortController();
    aborted.abort();
    const r3 = await followRedirectors(`http://redir.test:${port}/a`, client, {
      maxHops: 5,
      isRedirector: (h) => h === 'redir.test',
      signal: aborted.signal,
    });
    assert.equal(r3.url, `http://redir.test:${port}/a`);
    assert.equal(seen.length, 0, 'an aborted job makes no further requests');
  } finally {
    server.close();
  }
});
