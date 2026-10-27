/**
 * Button / state detection against real DOM rendered by Chromium. Each fixture
 * is a different layout; the probe + scoring must find the right element
 * without any page-specific selectors.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { pageProbe } from '../../src/agent/pageProbe.ts';
import { ACTIONABLE_THRESHOLD, candidateLabel, scoreCandidate } from '../../src/agent/scoring.ts';
import { assessChallenge } from '../../src/agent/classifier.ts';
import type { PageSnapshot, ProbeResult, ScoredCandidate } from '../../src/agent/types.ts';

let browser: Browser;
let page: Page;

before(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.route('**/*', (r) => r.abort()); // fixtures are self-contained; no network
});
after(async () => {
  await browser?.close();
});

async function analyse(html: string): Promise<{ probe: ProbeResult; ranked: ScoredCandidate[]; snap: PageSnapshot }> {
  await page.setContent(
    `<!DOCTYPE html><html><head><style>.btn{display:inline-block;padding:10px 20px;background:#3a7;color:#fff;cursor:pointer}</style></head><body>${html}</body></html>`,
  );
  const probe = await page.evaluate(pageProbe, {
    attr: 'data-t',
    maxCandidates: 150,
    textLimit: 6000,
    hintSelectors: ['a.get-link:not(.disabled)'],
  });
  const ctx = {
    pageUrl: 'https://blog.example/post',
    isFlowHost: (h: string) => h === 'arolinks.com',
    attempts: new Map<string, number>(),
  };
  const ranked = probe.candidates
    .map(
      (c) => ({ ...c, ...scoreCandidate(c, ctx), frame: page.mainFrame(), frameUrl: '', signature: '', hrefHost: null }) as ScoredCandidate,
    )
    .sort((a, b) => b.score - a.score);
  const snap: PageSnapshot = {
    url: probe.url,
    host: 'blog.example',
    title: probe.title,
    text: probe.text,
    textLength: probe.textLength,
    probe,
    candidates: ranked,
    countdowns: probe.countdowns,
    challenge: probe.challenge,
    markers: probe.markers,
    status: 200,
    takenAt: Date.now(),
  };
  return { probe, ranked, snap };
}

const best = (ranked: ScoredCandidate[]) => ranked.find((c) => !c.disabled && c.score >= ACTIONABLE_THRESHOLD);

describe('button detection across layouts', () => {
  it('picks the real Continue button over decoys in ad containers and navigation', async () => {
    const { ranked } = await analyse(`
      <nav><a href="/">Home</a><a href="/about">About</a><a href="/login">Login</a></nav>
      <div class="ads-wrapper"><a class="btn" href="https://ads.example/1">Continue</a><a class="btn" href="https://ads.example/2">Download Now</a></div>
      <article><p>${'Some article text. '.repeat(40)}</p><a href="https://blog.example/next">Next Post »</a></article>
      <div class="text-center"><a id="btn-continue" class="btn" href="https://arolinks.com/abc?step=2">Continue</a></div>
      <footer><a href="/privacy">Privacy Policy</a></footer>`);
    assert.equal(best(ranked)?.id, 'btn-continue');
  });

  it('detects icon-only links via aria-label and image buttons via alt text', async () => {
    const icon = await analyse(
      `<a aria-label="Get Link" href="https://dest.example/x" style="display:inline-block;width:48px;height:48px;background:#2a2"><svg width="40" height="40"></svg></a>`,
    );
    assert.equal(candidateLabel(best(icon.ranked)!), 'Get Link');
    const img = await analyse(`<a href="https://arolinks.com/go"><img alt="Get Link" width="160" height="50" style="background:#2a2"></a>`);
    assert.equal(candidateLabel(best(img.ranked)!), 'Get Link');
  });

  it('detects role=button divs, input submits and cursor:pointer spans', async () => {
    assert.equal(
      candidateLabel(best((await analyse(`<div role="button" class="next" style="padding:12px">Proceed</div>`)).ranked)!),
      'Proceed',
    );
    assert.equal(
      candidateLabel(best((await analyse(`<form action="/x" method="post"><input type="submit" value="Verify"></form>`)).ranked)!),
      'Verify',
    );
    assert.equal(
      candidateLabel(
        best((await analyse(`<span style="cursor:pointer;padding:12px;background:#36c" onclick="void 0">Lanjutkan</span>`)).ranked)!,
      ),
      'Lanjutkan',
    );
    assert.equal(
      candidateLabel(
        best(
          (await analyse(`<div class="x" style="cursor:pointer;padding:14px;background:#36c"><span>Click here to continue</span></div>`))
            .ranked,
        )!,
      ),
      'Click here to continue',
    );
  });

  it('prefers the AdLinkFly get-link once released and reports it as disabled before that', async () => {
    const html = (cls: string, href: string) => `
      <form id="go-link" action="/links/go" method="post"><input type="hidden" name="ad_form_data" value="x"></form>
      <span id="timer">5</span><a href="${href}" class="btn btn-success btn-lg get-link ${cls}">Get Link</a>
      <script>var app_vars = {"counter_value":"5"};</script>`;
    const locked = await analyse(html('disabled', 'javascript: void(0)'));
    assert.equal(locked.probe.markers.goLinkForm, true);
    assert.equal(locked.probe.markers.getLink?.disabled, true);
    assert.equal(locked.probe.markers.counterValue, 5);
    assert.equal(best(locked.ranked), undefined, 'disabled get-link is not clickable yet');
    const released = await analyse(html('', 'https://dest.example/file'));
    assert.equal(released.probe.markers.getLink?.href, 'https://dest.example/file');
    assert.ok(best(released.ranked)!.className.includes('get-link'));
  });

  it('ignores hidden elements but notices them, and flags covered elements', async () => {
    const hidden = await analyse(`<a class="btn" style="display:none" href="https://x.example/">Get Link</a><p>Please wait</p>`);
    assert.equal(hidden.probe.candidates.length, 0);
    assert.equal(hidden.probe.hiddenStrongCandidates, 1);
    const covered =
      await analyse(`<a id="t" class="btn" href="https://x.example/" style="position:absolute;top:100px;left:100px">Continue</a>
      <div style="position:fixed;inset:0;z-index:99;background:rgba(0,0,0,.01)"></div>`);
    assert.equal(covered.probe.candidates.find((c) => c.id === 't')?.obscured, true);
  });

  it('finds nothing actionable on pages with only site chrome', async () => {
    const { ranked } = await analyse(
      `<header><a href="/">Home</a> <a href="/contact">Contact</a></header><p>Welcome.</p><a href="/next">Next Post</a><a href="/share">Share on Twitter</a>`,
    );
    assert.equal(best(ranked), undefined);
  });
});

describe('page state detection', () => {
  it('reads countdowns from timer elements and from page text', async () => {
    const { probe } = await analyse(`<div>Please wait <span id="countdown">15</span></div><p>Your link will be ready in 12 seconds.</p>`);
    const values = probe.countdowns.map((c) => c.value);
    assert.ok(values.includes(15), JSON.stringify(values));
    assert.ok(values.includes(12), JSON.stringify(values));
  });

  it('ignores counters that are not timers (views, comments, discounts, accounts)', async () => {
    const { probe } = await analyse(`<span class="post-views-count">1240</span><span class="comment-count">12</span>
      <span class="discount">30</span><div id="account">5</div><span id="timer">9</span>`);
    assert.deepEqual(
      probe.countdowns.map((c) => c.value),
      [9],
    );
    assert.equal(probe.countdowns[0]!.hasUnit, false, 'a bare number still needs to be seen ticking');
  });

  it('detects meta refresh targets', async () => {
    const { probe } = await analyse(`<meta http-equiv="refresh" content="3; url=https://next.example/step">`);
    assert.deepEqual(probe.metaRefresh, { delay: 3, url: 'https://next.example/step' });
  });

  it('detects visible reCAPTCHA, hCaptcha and Turnstile widgets as blocking challenges', async () => {
    const rc = await analyse(
      `<div class="g-recaptcha" data-sitekey="k"><iframe src="https://www.google.com/recaptcha/api2/anchor?k=k&size=normal" width="304" height="78"></iframe></div>`,
    );
    assert.ok(rc.probe.challenge.visibleWidgets.includes('recaptcha'));
    assert.equal(assessChallenge(rc.snap).blocking, true);
    const hc = await analyse(`<div class="h-captcha" data-sitekey="k" style="width:303px;height:78px"></div>`);
    assert.ok(hc.probe.challenge.visibleWidgets.includes('hcaptcha'));
    const ts = await analyse(`<div class="cf-turnstile" data-sitekey="k" style="width:300px;height:65px"></div>`);
    assert.ok(ts.probe.challenge.visibleWidgets.includes('turnstile'));
  });

  it('distinguishes passive reCAPTCHA scripts from CAPTCHAs bound to the continue action', async () => {
    const passive = await analyse(
      `<script src="https://www.google.com/recaptcha/api.js?render=k"></script><button class="btn">Continue</button>`,
    );
    assert.equal(assessChallenge(passive.snap).blocking, false);
    const bound = await analyse(
      `<script src="https://www.google.com/recaptcha/api.js"></script><button class="g-recaptcha btn" data-sitekey="k" data-callback="onOk">Continue</button>`,
    );
    assert.equal(assessChallenge(bound.snap).blocking, true);
  });

  it('detects Cloudflare interstitials and text CAPTCHAs', async () => {
    const cf = await analyse(`<div id="challenge-running">Checking if the site connection is secure</div>`);
    assert.equal(assessChallenge(cf.snap).interstitial, true);
    const txt = await analyse(`<img src="/captcha.php" width="120" height="40" alt="captcha"><input name="captcha_code" type="text">`);
    assert.equal(assessChallenge(txt.snap).type, 'text_captcha');
  });
});
