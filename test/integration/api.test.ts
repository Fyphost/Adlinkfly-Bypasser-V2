/** REST API contract: auth, validation, rate limiting, async jobs, caching, headers, health and metrics. */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockSites, type MockSites } from '../helpers/mockSites.ts';
import { OTHER_API_KEY, TEST_API_KEY, postResolve, startTestApp, type TestApp } from '../helpers/testApp.ts';

let sites: MockSites;
let t: TestApp;

before(async () => {
  sites = await startMockSites();
  t = await startTestApp({
    ADLINKFLY_EXTRA_DOMAINS: 'short.test,internal.test,mixed.test',
    RESULT_CACHE_TTL_MS: '60000',
    MAX_BODY_BYTES: '512',
    CORS_ORIGINS: 'https://app.example',
  });
});
after(async () => {
  await t?.close();
  await sites?.close();
});

const get = (path: string, key: string | null = TEST_API_KEY, headers: Record<string, string> = {}) =>
  fetch(`${t.base}${path}`, { headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers } });

describe('authentication', () => {
  it('rejects missing and invalid API keys with 401', async () => {
    const missing = await postResolve(t.base, { url: sites.url('short.test', '/basic') }, { key: null });
    assert.equal(missing.status, 401);
    assert.equal(missing.body.error_code, 'UNAUTHORIZED');
    assert.equal(missing.headers.get('www-authenticate'), 'Bearer realm="api"');
    const wrong = await postResolve(t.base, { url: sites.url('short.test', '/basic') }, { key: 'definitely-not-a-valid-key' });
    assert.equal(wrong.status, 401);
  });

  it('accepts the X-API-Key header', async () => {
    const r = await fetch(`${t.base}/api/shorteners`, { headers: { 'x-api-key': TEST_API_KEY } });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { shorteners: Array<{ id: string; domains: string[] }> };
    assert.ok(body.shorteners.some((s) => s.id === 'arolinks' && s.domains.includes('arolinks.com')));
  });

  it('locks out an IP after repeated authentication failures', async () => {
    const app = await startTestApp({ AUTH_FAILURES_PER_MINUTE: '3' });
    try {
      for (let i = 0; i < 3; i++) assert.equal((await postResolve(app.base, { url: 'x' }, { key: 'wrong-key-wrong-key' })).status, 401);
      const locked = await postResolve(app.base, { url: 'x' }, { key: TEST_API_KEY });
      assert.equal(locked.status, 429);
      assert.ok(Number(locked.headers.get('retry-after')) >= 1);
    } finally {
      await app.close();
    }
  });
});

describe('request validation', () => {
  it('validates content type, JSON, size and fields', async () => {
    const wrongType = await postResolve(t.base, null, { raw: 'url=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(wrongType.status, 415);
    const badJson = await postResolve(t.base, null, { raw: '{"url":' });
    assert.equal(badJson.status, 400);
    assert.equal(badJson.body.error_code, 'INVALID_REQUEST');
    const tooBig = await postResolve(t.base, { url: `https://arolinks.com/${'a'.repeat(1000)}` });
    assert.equal(tooBig.status, 413);
    const missing = await postResolve(t.base, {});
    assert.equal(missing.status, 400);
    assert.match(String(missing.body.error), /"url" field is required/);
    const notString = await postResolve(t.base, { url: 123 });
    assert.equal(notString.status, 400);
    assert.equal(notString.body.error_code, 'INVALID_URL');
    const badFlag = await postResolve(t.base, { url: 'https://arolinks.com/x', async: 'yes' });
    assert.equal(badFlag.status, 400);
    const arr = await postResolve(t.base, ['https://arolinks.com/x']);
    assert.equal(arr.status, 400);
  });

  it('rejects unsupported schemes and shorteners', async () => {
    const js = await postResolve(t.base, { url: 'javascript:alert(1)' });
    assert.equal(js.status, 400);
    assert.equal(js.body.original_url, 'javascript:alert(1)');
    const unsupported = await postResolve(t.base, { url: 'https://example.com/abc' });
    assert.equal(unsupported.status, 422);
    assert.equal(unsupported.body.error_code, 'UNSUPPORTED_SHORTENER');
    assert.ok(Array.isArray(unsupported.body.supported));
  });

  it('prevents SSRF at submission: private literals and hosts resolving to private addresses', async () => {
    for (const url of [
      'http://127.0.0.2/x',
      'http://[::1]/x',
      'http://169.254.169.254/latest',
      `http://internal.test:${sites.port}/abc`,
      `http://mixed.test:${sites.port}/abc`,
    ]) {
      const r = await postResolve(t.base, { url });
      assert.equal(r.status, 403, `${url}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error_code, 'URL_NOT_ALLOWED');
    }
  });

  it('answers unknown routes with 404 and wrong methods with 405', async () => {
    assert.equal((await get('/nope')).status, 404);
    const r = await get('/api/resolve');
    assert.equal(r.status, 405);
    assert.equal(r.headers.get('allow'), 'POST');
  });
});

describe('responses', () => {
  it('returns the documented success shape and serves repeats from the cache', async () => {
    const url = sites.url('short.test', '/c-cache');
    const first = await postResolve(t.base, { url });
    assert.equal(first.status, 200);
    for (const k of ['success', 'original_url', 'destination_url', 'message']) assert.ok(k in first.body, k);
    assert.equal(first.body.cached, false);
    const second = await postResolve(t.base, { url });
    assert.equal(second.body.cached, true);
    assert.equal(second.body.destination_url, first.body.destination_url);
    assert.equal(sites.hits.get('short.test /c-cache'), 1, 'the shortener was only visited once');
    const bypass = await postResolve(t.base, { url, no_cache: true });
    assert.equal(bypass.body.cached, false);
  });

  it('sets security headers and propagates request ids', async () => {
    const r = await get('/health', null, { 'x-request-id': 'abc-123' });
    assert.equal(r.headers.get('x-request-id'), 'abc-123');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    const generated = await get('/health', null, { 'x-request-id': 'bad id with spaces' });
    assert.match(generated.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
  });

  it('answers CORS preflights only for configured origins', async () => {
    const ok = await fetch(`${t.base}/api/resolve`, {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example', 'access-control-request-method': 'POST' },
    });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://app.example');
    const other = await fetch(`${t.base}/api/resolve`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    assert.equal(other.headers.get('access-control-allow-origin'), null);
  });
});

describe('asynchronous jobs', () => {
  it('accepts a job, reports progress and returns the final result to its owner only', async () => {
    const url = sites.url('short.test', '/c-async');
    const accepted = await postResolve(t.base, { url, async: true });
    assert.equal(accepted.status, 202);
    assert.equal(accepted.body.status, 'queued');
    const id = String(accepted.body.job_id);
    assert.equal(accepted.headers.get('location'), `/api/jobs/${id}`);
    assert.equal((await get(`/api/jobs/${id}`, OTHER_API_KEY)).status, 404, 'other API keys cannot read the job');
    let body: Record<string, unknown> = {};
    for (let i = 0; i < 60; i++) {
      body = (await (await get(`/api/jobs/${id}`)).json()) as Record<string, unknown>;
      if (body.job_status === 'completed' || body.job_status === 'failed') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(body.job_status, 'completed', JSON.stringify(body));
    assert.equal(body.success, true);
    assert.equal(body.destination_url, sites.url('dest.test', '/landing?id=c-async'));
  });

  it('records failures in the job result', async () => {
    const accepted = await postResolve(t.base, { url: sites.url('short.test', '/expired'), async: true });
    const id = String(accepted.body.job_id);
    let body: Record<string, unknown> = {};
    for (let i = 0; i < 60; i++) {
      body = (await (await get(`/api/jobs/${id}`)).json()) as Record<string, unknown>;
      if (body.job_status === 'failed' || body.job_status === 'completed') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(body.job_status, 'failed');
    assert.equal(body.http_status, 410);
    assert.equal(body.error_code, 'LINK_EXPIRED');
  });

  it('validates async requests synchronously', async () => {
    const r = await postResolve(t.base, { url: 'https://example.com/x', async: true });
    assert.equal(r.status, 422);
  });
});

describe('unlisted shorteners', () => {
  it('are rejected by default and handled by the generic agent when ALLOW_UNLISTED_SHORTENERS=true', async () => {
    const url = sites.url('unlisted.test', '/basic');
    assert.equal((await postResolve(t.base, { url })).status, 422);
    const app = await startTestApp({ ALLOW_UNLISTED_SHORTENERS: 'true' });
    try {
      const r = await postResolve(app.base, { url });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.shortener, 'generic');
      assert.equal(r.body.original_url, url);
      assert.equal(r.body.destination_url, sites.url('dest.test', '/landing?id=basic'));
    } finally {
      await app.close();
    }
  });
});

describe('rate limiting', () => {
  it('limits per API key and returns RateLimit headers', async () => {
    const app = await startTestApp({ RATE_LIMIT_PER_MINUTE: '2', RATE_LIMIT_BURST: '2' });
    try {
      const a = await postResolve(app.base, { url: 'https://example.com/a' });
      assert.equal(a.headers.get('ratelimit-limit'), '2');
      assert.equal(a.headers.get('ratelimit-remaining'), '1');
      await postResolve(app.base, { url: 'https://example.com/b' });
      const c = await postResolve(app.base, { url: 'https://example.com/c' });
      assert.equal(c.status, 429);
      assert.equal(c.body.error_code, 'RATE_LIMITED');
      assert.ok(Number(c.headers.get('retry-after')) >= 1);
      const otherKey = await postResolve(app.base, { url: 'https://example.com/d' }, { key: OTHER_API_KEY });
      assert.notEqual(otherKey.status, 429, 'buckets are per key');
    } finally {
      await app.close();
    }
  });
});

describe('operations endpoints', () => {
  it('exposes health, readiness and metrics', async () => {
    const health = await get('/health', null);
    assert.equal(health.status, 200);
    const ready = await get('/ready', null);
    assert.equal(ready.status, 200);
    const readyBody = (await ready.json()) as { status: string; browser: { connected: boolean } };
    assert.equal(readyBody.status, 'ready');
    assert.equal(readyBody.browser.connected, true);
    assert.equal((await get('/metrics', null)).status, 401, 'metrics require auth by default');
    const metrics = await get('/metrics');
    assert.equal(metrics.status, 200);
    const text = await metrics.text();
    assert.match(text, /resolver_resolutions_total\{/);
    assert.match(text, /resolver_queue_active_jobs \d+/);
    assert.match(text, /resolver_http_requests_total\{/);
  });
});
