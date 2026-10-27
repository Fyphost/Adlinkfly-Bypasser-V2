/** Concurrent requests: bounded parallelism, load shedding, de-duplication and resource cleanup. */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockSites, type MockSites } from '../helpers/mockSites.ts';
import { postResolve, startTestApp } from '../helpers/testApp.ts';

let sites: MockSites;

before(async () => {
  sites = await startMockSites();
});
after(async () => {
  await sites?.close();
});

describe('concurrency', () => {
  it('resolves many links in parallel without exceeding MAX_CONCURRENT_JOBS', async () => {
    const t = await startTestApp({ MAX_CONCURRENT_JOBS: '3', MAX_QUEUE_SIZE: '20' });
    try {
      let peakActive = 0;
      let peakContexts = 0;
      const sampler = setInterval(() => {
        peakActive = Math.max(peakActive, t.app.queue.stats().active);
        peakContexts = Math.max(peakContexts, t.app.browsers.status().activeContexts);
      }, 20);
      const ids = Array.from({ length: 8 }, (_, i) => `c-par${i}`);
      const results = await Promise.all(ids.map((id) => postResolve(t.base, { url: sites.url('short.test', `/${id}`) })));
      clearInterval(sampler);
      results.forEach((r, i) => {
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.destination_url, sites.url('dest.test', `/landing?id=${ids[i]}`));
      });
      assert.ok(peakActive <= 3 && peakActive >= 2, `peak active jobs ${peakActive}`);
      assert.ok(peakContexts <= 3, `peak browser contexts ${peakContexts}`);
      await t.app.queue.onIdle();
      assert.equal(t.app.browsers.status().activeContexts, 0, 'all contexts closed');
      assert.equal(t.app.proxy.activeSessions, 0, 'all egress sessions closed');
      assert.equal(t.app.browsers.stats.launches, 1, 'one shared browser process');
    } finally {
      await t.close();
    }
  });

  it('sheds load with 503 QUEUE_FULL and Retry-After when the queue is full', async () => {
    const t = await startTestApp({ MAX_CONCURRENT_JOBS: '1', MAX_QUEUE_SIZE: '1' });
    try {
      const results = await Promise.all(
        ['c-q1', 'c-q2', 'c-q3'].map((id) => postResolve(t.base, { url: sites.url('short.test', `/${id}`) })),
      );
      const statuses = results.map((r) => r.status).sort();
      assert.deepEqual(statuses, [200, 200, 503]);
      const rejected = results.find((r) => r.status === 503)!;
      assert.equal(rejected.body.error_code, 'QUEUE_FULL');
      assert.ok(Number(rejected.headers.get('retry-after')) >= 1);
    } finally {
      await t.close();
    }
  });

  it('coalesces concurrent requests for the same link into one browser job', async () => {
    const t = await startTestApp({ MAX_CONCURRENT_JOBS: '3' });
    try {
      const url = sites.url('short.test', '/c-dedupe');
      const results = await Promise.all(Array.from({ length: 4 }, () => postResolve(t.base, { url })));
      for (const r of results) assert.equal(r.body.destination_url, sites.url('dest.test', '/landing?id=c-dedupe'));
      assert.equal(sites.hits.get('short.test /c-dedupe'), 1);
    } finally {
      await t.close();
    }
  });

  it('graceful shutdown lets running jobs finish and refuses queued ones', async () => {
    const t = await startTestApp({ MAX_CONCURRENT_JOBS: '1', MAX_QUEUE_SIZE: '5', SHUTDOWN_GRACE_MS: '30000' });
    const running = postResolve(t.base, { url: sites.url('short.test', '/c-shutdown1') });
    await new Promise((r) => setTimeout(r, 400));
    const queued = postResolve(t.base, { url: sites.url('short.test', '/c-shutdown2') });
    await new Promise((r) => setTimeout(r, 300));
    const closing = t.close();
    const [a, b] = await Promise.all([running, queued]);
    await closing;
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.destination_url, sites.url('dest.test', '/landing?id=c-shutdown1'));
    assert.equal(b.status, 503);
    assert.equal(b.body.error_code, 'SHUTTING_DOWN');
  });

  it('cancels the browser job when the client disconnects', async () => {
    const t = await startTestApp({ MAX_CONCURRENT_JOBS: '2' });
    try {
      const controller = new AbortController();
      const req = fetch(`${t.base}/api/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer test-key-0123456789abcdef` },
        body: JSON.stringify({ url: sites.url('arolinks.com', '/multi') }),
        signal: controller.signal,
      }).catch(() => null);
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(t.app.queue.stats().active, 1);
      controller.abort();
      await req;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && (t.app.queue.stats().active > 0 || t.app.browsers.status().activeContexts > 0)) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(t.app.queue.stats().active, 0);
      assert.equal(t.app.browsers.status().activeContexts, 0);
    } finally {
      await t.close();
    }
  });
});
