import { test } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';
import { RateLimiter } from '../../src/api/rateLimiter.ts';
import { Authenticator } from '../../src/api/auth.ts';
import { clientIp } from '../../src/api/http.ts';
import { ConfigError, hashApiKey, loadConfig } from '../../src/config.ts';
import { parseAiDecision, LlmAdvisor } from '../../src/agent/aiAdvisor.ts';
import { silentLogger } from '../../src/logger.ts';

const fakeReq = (headers: Record<string, string>, remote = '10.0.0.9') =>
  ({ headers, socket: { remoteAddress: remote } }) as unknown as http.IncomingMessage;

test('token bucket allows bursts, then limits and refills', () => {
  const rl = new RateLimiter({ perMinute: 60, burst: 3 });
  const t0 = 1_000_000;
  assert.ok(rl.take('k', 1, t0).allowed);
  assert.ok(rl.take('k', 1, t0).allowed);
  assert.ok(rl.take('k', 1, t0).allowed);
  const denied = rl.take('k', 1, t0);
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfter, 1);
  assert.ok(rl.take('k', 1, t0 + 1000).allowed, 'refilled one token after 1s');
  assert.ok(rl.take('other', 1, t0).allowed, 'keys are independent');
});

test('authenticates Bearer and X-API-Key headers against hashed keys', () => {
  const cfg = loadConfig({ API_KEYS: 'alice:alice-key-0123456789', API_KEY_HASHES: `bob:${hashApiKey('bob-key-0123456789abc')}` });
  const auth = new Authenticator(cfg.auth);
  assert.deepEqual(auth.authenticate(fakeReq({ authorization: 'Bearer alice-key-0123456789' })), { ok: true, keyId: 'alice' });
  assert.deepEqual(auth.authenticate(fakeReq({ 'x-api-key': 'bob-key-0123456789abc' })), { ok: true, keyId: 'bob' });
  assert.deepEqual(auth.authenticate(fakeReq({ authorization: 'Bearer wrong' })), { ok: false, reason: 'invalid' });
  assert.deepEqual(auth.authenticate(fakeReq({})), { ok: false, reason: 'missing' });
});

test('client IP honours X-Forwarded-For only for trusted hops', () => {
  const req = fakeReq({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' }, '::ffff:10.0.0.1');
  assert.equal(clientIp(req, 0), '10.0.0.1');
  assert.equal(clientIp(req, 1), '3.3.3.3');
  assert.equal(clientIp(req, 2), '2.2.2.2');
  assert.equal(clientIp(req, 9), '1.1.1.1');
});

test('configuration is validated and secure by default', () => {
  assert.throws(() => loadConfig({}), ConfigError, 'API keys are mandatory unless auth is disabled');
  assert.throws(() => loadConfig({ API_KEYS: 'short' }), ConfigError);
  assert.throws(() => loadConfig({ AUTH_DISABLED: 'true', PORT: 'abc' }), ConfigError);
  assert.throws(() => loadConfig({ AUTH_DISABLED: 'true', ALLOW_PRIVATE_NETWORK_CIDRS: 'not-a-cidr' }), ConfigError);
  assert.throws(() => loadConfig({ AUTH_DISABLED: 'true', AI_PROVIDER: 'openai' }), ConfigError, 'AI requires model and key');
  const cfg = loadConfig({ AUTH_DISABLED: 'true' });
  assert.deepEqual([...(cfg.network.allowedPorts as Set<number>)], [80, 443]);
  assert.deepEqual(cfg.network.allowPrivateCidrs, []);
  assert.equal(cfg.shorteners.allowUnlisted, false);
  assert.equal(cfg.ai.provider, 'none');
  try {
    loadConfig({ AUTH_DISABLED: 'true', MAX_CONCURRENT_JOBS: '0', LOG_LEVEL: 'loud' });
    assert.fail('expected ConfigError');
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    assert.equal(e.problems.length, 2, 'all problems are reported at once');
  }
});

test('AI decisions are strictly validated', () => {
  assert.deepEqual(parseAiDecision('{"action":"click","index":2,"reason":"get link"}', 3), {
    action: 'click',
    index: 2,
    reason: 'get link',
  });
  assert.equal(parseAiDecision('{"action":"click","index":5}', 3), null, 'index out of range');
  assert.deepEqual(parseAiDecision('Sure! {"action":"wait","seconds":500}', 3), { action: 'wait', seconds: 30, reason: '' });
  assert.equal(parseAiDecision('{"action":"solve_captcha"}', 3), null);
  assert.equal(parseAiDecision('no json here', 3), null);
});

test('AI advisor speaks the OpenAI-compatible and Anthropic wire formats', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown>, headers: init.headers as Record<string, string> });
    const content = '{"action":"click","index":0,"reason":"ok"}';
    const payload = url.endsWith('/chat/completions')
      ? { choices: [{ message: { content } }] }
      : { content: [{ type: 'text', text: content }] };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const input = {
    url: 'https://x.example',
    title: 't',
    step: 1,
    situation: 's',
    text: 'page',
    countdowns: [],
    candidates: [
      { index: 0, tag: 'div', label: '', href_host: null, href_path: null, id: null, class: 'q7', disabled: false, heuristic_score: 0 },
    ],
  };
  const base = { apiKey: 'sk-test', model: 'm', timeoutMs: 5000, maxCallsPerJob: 2, jsonMode: true };
  const openai = new LlmAdvisor({ ...base, provider: 'openai', baseUrl: 'https://api.example/v1' }, silentLogger, fakeFetch);
  assert.deepEqual(await openai.decide(input), { action: 'click', index: 0, reason: 'ok' });
  assert.equal(calls[0]!.url, 'https://api.example/v1/chat/completions');
  assert.equal(calls[0]!.headers.authorization, 'Bearer sk-test');
  const anthropic = new LlmAdvisor({ ...base, provider: 'anthropic', baseUrl: 'https://api.anthropic.example' }, silentLogger, fakeFetch);
  assert.deepEqual(await anthropic.decide(input), { action: 'click', index: 0, reason: 'ok' });
  assert.equal(calls[1]!.url, 'https://api.anthropic.example/v1/messages');
  assert.equal(calls[1]!.headers['x-api-key'], 'sk-test');
  const failing = new LlmAdvisor(
    { ...base, provider: 'openai', baseUrl: 'https://api.example/v1' },
    silentLogger,
    (async () => new Response('err', { status: 500 })) as unknown as typeof fetch,
  );
  assert.equal(await failing.decide(input), null, 'provider failures degrade gracefully');
});
