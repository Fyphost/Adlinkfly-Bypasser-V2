import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INTERMEDIATE_THRESHOLD, assessChallenge, detectErrorPage, intermediateScore } from '../../src/agent/classifier.ts';
import type { PageSnapshot, ScoredCandidate } from '../../src/agent/types.ts';

type SnapshotInput = Omit<Partial<PageSnapshot>, 'candidates' | 'challenge' | 'markers' | 'probe'> & {
  candidates?: Array<Partial<ScoredCandidate>>;
  challenge?: Partial<PageSnapshot['challenge']>;
  markers?: Partial<PageSnapshot['markers']>;
  probe?: Partial<PageSnapshot['probe']>;
};

function snapshot(p: SnapshotInput = {}): PageSnapshot {
  const url = p.url ?? 'https://blog.example/post';
  const defaults: Partial<ScoredCandidate> = {
    agentId: '1',
    tag: 'button',
    text: '',
    ariaLabel: null,
    title: null,
    alt: null,
    href: null,
    score: 0,
    disabled: false,
  };
  const candidates = (p.candidates ?? []).map((c) => ({ ...defaults, ...c }) as ScoredCandidate);
  return {
    url,
    host: new URL(url).hostname,
    title: p.title ?? 'A page',
    text: p.text ?? '',
    textLength: (p.text ?? '').length,
    status: p.status ?? 200,
    takenAt: Date.now(),
    countdowns: p.countdowns ?? [],
    candidates,
    challenge: {
      providers: [],
      visibleWidgets: [],
      invisibleBound: false,
      scriptBound: false,
      cloudflareInterstitial: false,
      captchaInputs: 0,
      captchaImages: 0,
      textCues: [],
      ...p.challenge,
    },
    markers: {
      goLinkForm: false,
      goLinkAction: null,
      linkViewForm: false,
      adFormData: false,
      captchaShortlink: false,
      getLink: null,
      counterValue: null,
      ...p.markers,
    },
    probe: {
      forms: [],
      linkHosts: {},
      metaRefresh: null,
      hiddenStrongCandidates: 0,
      scroll: { y: 0, height: 800, viewport: 768 },
      ...(p.probe ?? {}),
    } as PageSnapshot['probe'],
  };
}

test('detects visible CAPTCHA widgets, Cloudflare challenges and text CAPTCHAs', () => {
  assert.equal(assessChallenge(snapshot({ challenge: { visibleWidgets: ['recaptcha'], providers: ['recaptcha'] } })).type, 'recaptcha');
  const cf = assessChallenge(snapshot({ challenge: { cloudflareInterstitial: true } }));
  assert.ok(cf.blocking && cf.interstitial);
  assert.ok(assessChallenge(snapshot({ challenge: { captchaInputs: 1 } })).blocking);
  assert.ok(assessChallenge(snapshot({ challenge: { textCues: ['verify you are human'] } })).blocking);
});

test('treats AdLinkFly CAPTCHA forms and invisible CAPTCHAs bound to the action as blocking', () => {
  assert.ok(
    assessChallenge(snapshot({ markers: { linkViewForm: true, captchaShortlink: true }, challenge: { providers: ['recaptcha'] } }))
      .blocking,
  );
  assert.ok(assessChallenge(snapshot({ markers: { linkViewForm: true }, challenge: { providers: ['solvemedia'] } })).blocking);
  assert.ok(
    assessChallenge(snapshot({ markers: { linkViewForm: true, captchaShortlink: true } })).blocking,
    'a widget rendered into #captchaShortlink is a CAPTCHA even without a recognised provider',
  );
  assert.ok(assessChallenge(snapshot({ challenge: { scriptBound: true } })).blocking, 'script-rendered widget');
  assert.equal(
    assessChallenge(
      snapshot({ markers: { linkViewForm: true, captchaShortlink: false }, candidates: [{ text: 'Click here to continue', score: 12 }] }),
    ).blocking,
    false,
    'CAPTCHA-free link-view step (CAPTCHA disabled by the operator) is a normal step',
  );
  assert.ok(assessChallenge(snapshot({ challenge: { invisibleBound: true, providers: ['hcaptcha'] } })).blocking);
});

test('treats "I am not a robot" style buttons as human verification', () => {
  const r = assessChallenge(snapshot({ candidates: [{ text: "I'm not a robot" }] }));
  assert.equal(r.type, 'human_attestation');
});

test('does not flag passive script loads or plain verify buttons', () => {
  assert.equal(
    assessChallenge(snapshot({ challenge: { providers: ['recaptcha'] }, candidates: [{ text: 'Verify', score: 8 }] })).blocking,
    false,
  );
});

test('detects expired, missing, banned and anti-adblock pages', () => {
  const on = { onShortenerHost: true, startPath: '/abc', path: '/abc' };
  assert.equal(detectErrorPage(snapshot({ text: 'Oops! This link has expired and is no longer available.' }), on)?.code, 'LINK_EXPIRED');
  assert.equal(detectErrorPage(snapshot({ text: 'The link you requested could not be found.' }), on)?.code, 'LINK_NOT_FOUND');
  assert.equal(detectErrorPage(snapshot({ text: 'This link has been banned for violating our terms' }), on)?.code, 'LINK_EXPIRED');
  assert.equal(detectErrorPage(snapshot({ status: 404 }), on)?.code, 'LINK_NOT_FOUND');
  assert.equal(detectErrorPage(snapshot({ status: 410 }), on)?.code, 'LINK_EXPIRED');
  assert.equal(detectErrorPage(snapshot({ status: 503 }), on)?.code, 'NAVIGATION_FAILED');
  assert.equal(
    detectErrorPage(snapshot({ text: 'Adblock detected! Please disable your adblocker to continue.' }), on)?.code,
    'ADBLOCK_WALL',
  );
  assert.equal(
    detectErrorPage(snapshot({ url: 'https://arolinks.com/' }), { onShortenerHost: true, startPath: '/abc', path: '/' })?.code,
    'LINK_NOT_FOUND',
  );
});

test('does not report errors on pages that still offer a strong action', () => {
  const on = { onShortenerHost: true, startPath: '/abc', path: '/abc' };
  assert.equal(
    detectErrorPage(snapshot({ text: 'Page not found? Click continue', candidates: [{ text: 'Continue', score: 9 }] }), on),
    null,
  );
  assert.equal(detectErrorPage(snapshot({ status: 404, markers: { goLinkForm: true } }), on), null);
});

test('scores intermediate blog pages above the threshold and plain destinations below it', () => {
  const flow = { isShortenerHost: (h: string) => h === 'arolinks.com', isFlowHost: (h: string) => h === 'arolinks.com' };
  const blog = snapshot({
    text: 'Scroll down and click the Verify button. Please wait 10 seconds to get your link.',
    countdowns: [{ key: 'a', value: 10, source: 'element', hasUnit: true }],
    candidates: [{ text: 'Verify', score: 9 }],
  });
  assert.ok(intermediateScore(blog, flow).score >= INTERMEDIATE_THRESHOLD);
  const linkBack = snapshot({ candidates: [{ text: 'Continue', score: 11, href: 'https://arolinks.com/abc?step=2' }] });
  assert.ok(intermediateScore(linkBack, flow).score >= INTERMEDIATE_THRESHOLD);
  const dest = snapshot({
    url: 'https://example.org/article',
    text: 'Welcome to our documentation. Read the guide below.',
    candidates: [{ text: 'Docs', score: 0 }],
  });
  assert.ok(intermediateScore(dest, flow).score < INTERMEDIATE_THRESHOLD);
  const shortener = snapshot({ url: 'https://arolinks.com/abc' });
  assert.ok(intermediateScore(shortener, flow).score >= INTERMEDIATE_THRESHOLD);
});
