/**
 * End-to-end resolution of supported flows through the real stack:
 * HTTP API → queue → Chromium (via the SSRF-safe egress proxy) → agent → extraction.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockSites, type MockSites } from '../helpers/mockSites.ts';
import { postResolve, startTestApp, type TestApp } from '../helpers/testApp.ts';

let sites: MockSites;
let t: TestApp;

before(async () => {
  sites = await startMockSites();
  t = await startTestApp({ MAX_CONCURRENT_JOBS: '4', MAX_QUEUE_SIZE: '50' });
});
after(async () => {
  await t?.close();
  await sites?.close();
});

async function resolve(host: string, path: string, extra: Record<string, unknown> = {}) {
  const url = sites.url(host, path);
  const r = await postResolve(t.base, { url, ...extra });
  return { ...r, url };
}

describe('supported shortener flows', { concurrency: 4 }, () => {
  it('resolves a classic AdLinkFly link (countdown + /links/go + get-link)', async () => {
    const r = await resolve('short.test', '/basic');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(
      { success: r.body.success, original_url: r.body.original_url, destination_url: r.body.destination_url, message: r.body.message },
      {
        success: true,
        original_url: r.url,
        destination_url: sites.url('dest.test', '/landing?id=basic'),
        message: 'Destination URL resolved successfully',
      },
    );
    assert.equal(r.body.shortener, 'adlinkfly');
  });

  it('resolves an arolinks.com multi-step flow through partner blog pages (scroll, verify, popup, countdown, continue)', async () => {
    const r = await resolve('arolinks.com', '/multi', { include_trace: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.destination_url, sites.url('dest.test', '/landing?id=multi'));
    assert.equal(r.body.shortener, 'arolinks');
    const actions = (r.body.trace as Array<{ action: string; url: string }>).map((s) => s.action);
    assert.ok(actions.includes('scroll'), 'revealed the verify button by scrolling');
    assert.ok(actions.includes('close-popup'), 'closed the ad pop-up opened by the first click');
    assert.ok(actions.filter((a) => a === 'click').length >= 3, 'clicked through verify / continue / proceed');
    const hosts = new Set(
      (r.body.trace as Array<{ url: string }>).map((s) => new URL(s.url.startsWith('http') ? s.url : 'about:blank').hostname),
    );
    assert.ok(hosts.has('blog-a.test') && hosts.has('blog-b.test'), 'visited both intermediate blogs');
    // The final step only works with the flow cookie set on the first visit and the blog Referer:
    // reaching the destination proves session state was preserved across hosts.
  });

  it('passes a CAPTCHA-free AdLinkFly link-view step (form POST) before the countdown page', async () => {
    const r = await resolve('short.test', '/linkview');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.destination_url, sites.url('dest.test', '/landing?id=linkview'));
  });

  it('handles different layouts: input submit → cursor:pointer span (Indonesian) → icon-only link', async () => {
    const r = await resolve('short.test', '/layouts');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.destination_url, sites.url('dest.test', '/layout-target'));
  });

  it('adopts a target=_blank pop-up that carries the next step', async () => {
    const r = await resolve('short.test', '/popup');
    assert.equal(r.body.destination_url, sites.url('dest.test', '/popup-target'), JSON.stringify(r.body));
  });

  it('follows the flow into a new tab when the original tab is redirected to an ad (tab-under)', async () => {
    const r = await resolve('short.test', '/tabunder');
    assert.equal(r.body.destination_url, sites.url('dest.test', '/tabunder-target'), JSON.stringify(r.body));
  });

  it('recovers when a click is hijacked to an ad network instead of mistaking the ad for the destination', async () => {
    const r = await resolve('short.test', '/hijack', { include_trace: true });
    assert.equal(r.body.destination_url, sites.url('dest.test', '/hijack-target'), JSON.stringify(r.body));
    assert.ok((r.body.trace as Array<{ action: string }>).some((s) => s.action === 'wrong-turn'));
  });

  it('waits for a disabled button to become enabled', async () => {
    const r = await resolve('short.test', '/disabled');
    assert.equal(r.body.destination_url, sites.url('dest.test', '/disabled-target'), JSON.stringify(r.body));
  });

  it('follows meta-refresh and JavaScript redirects', async () => {
    const [meta, js] = await Promise.all([resolve('short.test', '/meta'), resolve('short.test', '/jsredirect')]);
    assert.equal(meta.body.destination_url, sites.url('dest.test', '/meta-target'), JSON.stringify(meta.body));
    assert.equal(js.body.destination_url, sites.url('dest.test', '/js-target'), JSON.stringify(js.body));
  });

  it('follows plain HTTP redirects and reports the final URL', async () => {
    const r = await resolve('short.test', '/direct');
    assert.equal(r.body.destination_url, sites.url('dest.test', '/direct-target'), JSON.stringify(r.body));
  });

  it('acts on buttons inside same-site iframes', async () => {
    const r = await resolve('short.test', '/frame');
    assert.equal(r.body.destination_url, sites.url('dest.test', '/frame-target'), JSON.stringify(r.body));
  });

  it('extracts download destinations without downloading them', async () => {
    const r = await resolve('short.test', '/download');
    assert.equal(r.body.destination_url, sites.url('dest.test', '/files/report.zip'), JSON.stringify(r.body));
  });

  it('separates the destination from tracking wrappers and parameters', async () => {
    const r = await resolve('short.test', '/wrapped');
    assert.equal(r.body.destination_url, sites.url('dest.test', '/wrapped-target?keep=1'), JSON.stringify(r.body));
  });

  it('follows a short link that points to another supported short link', async () => {
    const r = await resolve('short.test', '/chain');
    assert.equal(r.body.destination_url, sites.url('dest.test', '/landing?id=basic'), JSON.stringify(r.body));
  });
});

describe('platform constraints and cleanup', () => {
  it('never triggered a server-side rejection of /links/go (countdowns were honoured, cookies kept)', () => {
    assert.ok(sites.stats.goCalls > 0);
    assert.equal(sites.stats.goRejected, 0);
  });

  it('released every browser context and egress session', async () => {
    await t.app.queue.onIdle();
    assert.equal(t.app.browsers.status().activeContexts, 0);
    assert.equal(t.app.proxy.activeSessions, 0);
  });
});
