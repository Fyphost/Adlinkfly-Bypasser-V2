/**
 * Error conditions: human verification, expired / missing links, anti-adblock
 * walls, missing buttons, SSRF via redirects, loops, step limits, countdown
 * limits, timeouts and browser crashes. Every failure must produce a
 * structured JSON error — never a crash or a false success.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockSites, type MockSites } from '../helpers/mockSites.ts';
import { postResolve, startTestApp, type TestApp } from '../helpers/testApp.ts';

let sites: MockSites;
let t: TestApp;

before(async () => {
  sites = await startMockSites();
  t = await startTestApp({ MAX_CONCURRENT_JOBS: '4', MAX_STEPS: '10', MAX_COUNTDOWN_WAIT_MS: '15000', CHALLENGE_AUTO_WAIT_MS: '1000' });
});
after(async () => {
  await t?.close();
  await sites?.close();
});

function assertErrorShape(body: Record<string, unknown>, url: string) {
  assert.equal(body.success, false);
  assert.equal(body.original_url, url);
  assert.equal(body.destination_url, null);
  assert.equal(typeof body.message, 'string');
  assert.equal(typeof body.error, 'string');
  assert.equal(typeof body.error_code, 'string');
}

async function expectError(path: string, httpStatus: number, code: string, host = 'short.test', app: TestApp = t) {
  const url = sites.url(host, path);
  const r = await postResolve(app.base, { url });
  assert.equal(r.status, httpStatus, JSON.stringify(r.body));
  assert.equal(r.body.error_code, code, JSON.stringify(r.body));
  assertErrorShape(r.body, url);
  return r.body;
}

describe('human verification is reported, never bypassed', { concurrency: 3 }, () => {
  it('AdLinkFly reCAPTCHA page', async () => {
    const b = await expectError('/captcha', 422, 'HUMAN_VERIFICATION_REQUIRED');
    assert.equal(b.status, 'human_verification_required');
    assert.equal(b.challenge_type, 'recaptcha');
    assert.equal(b.verification_url, sites.url('short.test', '/captcha'));
    assert.match(String(b.message), /Human verification is required/);
  });

  it('Cloudflare / Turnstile challenge (waits briefly, does not interact)', async () => {
    const b = await expectError('/cf', 422, 'HUMAN_VERIFICATION_REQUIRED');
    assert.equal(b.challenge_type, 'cloudflare_challenge');
  });

  it('invisible CAPTCHA bound from script (grecaptcha.render) is detected and not clicked', async () => {
    const b = await expectError('/scriptcaptcha', 422, 'HUMAN_VERIFICATION_REQUIRED');
    assert.match(String(b.error), /CAPTCHA widget rendered/);
    assert.equal(sites.hits.get('dest.test /scriptcaptcha-target') ?? 0, 0);
  });

  it('"I\'m not a robot" button is never clicked', async () => {
    await expectError('/robot', 422, 'HUMAN_VERIFICATION_REQUIRED');
    assert.equal(sites.hits.get('dest.test /robot-target') ?? 0, 0);
  });
});

describe('unavailable links and walls', { concurrency: 4 }, () => {
  it('expired link', async () => {
    const b = await expectError('/expired', 410, 'LINK_EXPIRED');
    assert.equal(b.status, 'link_unavailable');
  });
  it('unknown alias (HTTP 404)', async () => {
    await expectError('/does-not-exist', 404, 'LINK_NOT_FOUND');
  });
  it('anti-adblock wall', async () => {
    await expectError('/adblock', 422, 'ADBLOCK_WALL');
  });
  it('page without any actionable element', async () => {
    await expectError('/noaction', 502, 'NO_ACTION_FOUND');
  });
});

describe('navigation safety', { concurrency: 4 }, () => {
  it('blocks redirects to hosts that resolve to cloud metadata addresses', async () => {
    const b = await expectError('/ssrf', 403, 'NAVIGATION_BLOCKED');
    assert.match(String(b.error), /meta\.test/);
  });
  it('blocks redirects to private IP literals', async () => {
    await expectError('/ssrf-ip', 403, 'NAVIGATION_BLOCKED');
  });
  it('blocks clicks that lead into the internal network', async () => {
    await expectError('/ssrf-internal', 403, 'NAVIGATION_BLOCKED');
  });
  it('detects redirect loops', async () => {
    await expectError('/redirect-loop', 502, 'REDIRECT_LOOP');
  });
  it('stops after the maximum number of navigation steps', async () => {
    const b = await expectError('/endless', 502, 'MAX_STEPS_EXCEEDED');
    assert.match(String(b.error), /^Maximum navigation attempts exceeded/);
    assert.equal(b.message, 'Unable to resolve the destination URL');
  });
  it('charges only page-demanded countdowns to MAX_COUNTDOWN_WAIT_MS', async () => {
    const app = await startTestApp({ MAX_COUNTDOWN_WAIT_MS: '0' });
    try {
      // Non-countdown waits (disabled button, meta refresh) still work with a zero countdown budget …
      for (const [path, target] of [
        ['/disabled', '/disabled-target'],
        ['/meta', '/meta-target'],
      ] as const) {
        const r = await postResolve(app.base, { url: sites.url('short.test', path) });
        assert.equal(r.body.destination_url, sites.url('dest.test', target), JSON.stringify(r.body));
      }
      // … while a real countdown is refused.
      await expectError('/c-budget', 504, 'COUNTDOWN_TOO_LONG', 'short.test', app);
    } finally {
      await app.close();
    }
  });

  it('refuses countdowns longer than the configured maximum', async () => {
    await expectError('/slow', 504, 'COUNTDOWN_TOO_LONG');
  });
});

describe('timeouts and crashes', () => {
  it('reports page load timeouts', async () => {
    const app = await startTestApp({ NAVIGATION_TIMEOUT_MS: '2000', JOB_TIMEOUT_MS: '20000' });
    try {
      await expectError('/hang', 504, 'NAVIGATION_TIMEOUT', 'short.test', app);
    } finally {
      await app.close();
    }
  });

  it('enforces the overall job deadline and cleans up the browser context', async () => {
    const app = await startTestApp({ NAVIGATION_TIMEOUT_MS: '3000', JOB_TIMEOUT_MS: '4000' });
    try {
      await expectError('/multi', 504, 'TIMEOUT', 'arolinks.com', app);
      await app.app.queue.onIdle();
      assert.equal(app.app.browsers.status().activeContexts, 0);
      assert.equal(app.app.proxy.activeSessions, 0);
    } finally {
      await app.close();
    }
  });

  it('recovers from a browser crash by relaunching and retrying the job', async () => {
    const app = await startTestApp({ RETRY_ON_BROWSER_CRASH: 'true' });
    try {
      const url = sites.url('short.test', '/c-crash1');
      const pending = postResolve(app.base, { url });
      await new Promise((r) => setTimeout(r, 700));
      await app.app.browsers.crashForTesting();
      const r = await pending;
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.destination_url, sites.url('dest.test', '/landing?id=c-crash1'));
      assert.ok(app.app.browsers.stats.crashes >= 1);
      assert.ok(app.app.browsers.stats.launches >= 2);
    } finally {
      await app.close();
    }
  });

  it('reports BROWSER_ERROR when retries are disabled, and the next request still succeeds', async () => {
    const app = await startTestApp({ RETRY_ON_BROWSER_CRASH: 'false' });
    try {
      const pending = postResolve(app.base, { url: sites.url('short.test', '/c-crash2') });
      await new Promise((r) => setTimeout(r, 700));
      await app.app.browsers.crashForTesting();
      const r = await pending;
      assert.equal(r.status, 503, JSON.stringify(r.body));
      assert.equal(r.body.error_code, 'BROWSER_ERROR');
      const again = await postResolve(app.base, { url: sites.url('short.test', '/c-crash3') });
      assert.equal(again.status, 200, JSON.stringify(again.body));
    } finally {
      await app.close();
    }
  });
});

describe('cleanup after failures', () => {
  it('released every browser context and egress session', async () => {
    await t.app.queue.onIdle();
    assert.equal(t.app.browsers.status().activeContexts, 0);
    assert.equal(t.app.proxy.activeSessions, 0);
  });
});
