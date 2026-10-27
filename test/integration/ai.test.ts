/**
 * AI-assisted decisions: when the heuristics find nothing (unlabelled,
 * identical-looking controls) the agent consults an OpenAI-compatible model.
 * A local mock model server stands in for the real provider.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { startMockSites, type MockSites } from '../helpers/mockSites.ts';
import { postResolve, startTestApp } from '../helpers/testApp.ts';

let sites: MockSites;
let model: http.Server;
let modelUrl = '';
const requests: Array<{ system: string; user: string; auth: string | undefined }> = [];
let mode: 'pick-q7' | 'blocked' = 'pick-q7';

before(async () => {
  sites = await startMockSites();
  model = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as { messages: Array<{ role: string; content: string }> };
      const system = body.messages.find((m) => m.role === 'system')!.content;
      const user = body.messages.find((m) => m.role === 'user')!.content;
      requests.push({ system, user, auth: req.headers.authorization });
      const summary = JSON.parse(user.slice(user.indexOf('{'))) as { candidates: Array<{ index: number; class: string }> };
      let decision: Record<string, unknown> = { action: 'give_up', reason: 'unknown' };
      if (mode === 'blocked') decision = { action: 'blocked', reason: 'captcha shown' };
      else {
        const target = summary.candidates.find((c) => c.class.includes('q7'));
        if (target) decision = { action: 'click', index: target.index, reason: 'green button continues the flow' };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(decision) } }] }));
    });
  });
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', () => r()));
  modelUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;
});

after(async () => {
  await sites?.close();
  await new Promise<void>((r) => model.close(() => r()));
});

describe('AI fallback', () => {
  it('without AI, unlabelled controls lead to NO_ACTION_FOUND', async () => {
    const t = await startTestApp();
    try {
      const r = await postResolve(t.base, { url: sites.url('short.test', '/obscure') });
      assert.equal(r.status, 502);
      assert.equal(r.body.error_code, 'NO_ACTION_FOUND');
    } finally {
      await t.close();
    }
  });

  it('with AI, the model chooses the right control and the flow completes', async () => {
    const t = await startTestApp({ AI_PROVIDER: 'openai', AI_BASE_URL: modelUrl, AI_MODEL: 'mock-model', AI_API_KEY: 'sk-test' });
    try {
      requests.length = 0;
      mode = 'pick-q7';
      const r = await postResolve(t.base, { url: sites.url('short.test', '/obscure') });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.destination_url, sites.url('dest.test', '/ai-target'));
      assert.ok(requests.length >= 1);
      assert.equal(requests[0]!.auth, 'Bearer sk-test');
      assert.match(requests[0]!.system, /NEVER try to solve, bypass or click CAPTCHAs/);
      assert.match(requests[0]!.user, /untrusted data/);
      assert.equal(sites.hits.get('ads.test /a') ?? 0, 0, 'did not click the decoys');
    } finally {
      await t.close();
    }
  });

  it('a model reporting human verification stops the job instead of guessing', async () => {
    const t = await startTestApp({ AI_PROVIDER: 'openai', AI_BASE_URL: modelUrl, AI_MODEL: 'mock-model', AI_API_KEY: 'sk-test' });
    try {
      mode = 'blocked';
      const r = await postResolve(t.base, { url: sites.url('short.test', '/obscure') });
      assert.equal(r.status, 422);
      assert.equal(r.body.error_code, 'HUMAN_VERIFICATION_REQUIRED');
    } finally {
      mode = 'pick-q7';
      await t.close();
    }
  });
});
