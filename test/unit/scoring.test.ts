import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONABLE_THRESHOLD, isHumanAttestation, normalizeLabel, scoreCandidate, type ScoringContext } from '../../src/agent/scoring.ts';
import type { RawCandidate } from '../../src/agent/types.ts';

const ctx: ScoringContext = {
  pageUrl: 'https://blog.example/post',
  isFlowHost: (h) => h === 'arolinks.com' || h === 'blog.example',
  attempts: new Map(),
};

function cand(partial: Partial<RawCandidate>): RawCandidate {
  return {
    agentId: 'x',
    tag: 'a',
    type: null,
    role: null,
    text: '',
    ariaLabel: null,
    title: null,
    alt: null,
    id: null,
    className: '',
    name: null,
    href: null,
    rawHref: null,
    target: null,
    hasOnclick: false,
    formId: null,
    formAction: null,
    formMethod: null,
    disabled: false,
    inViewport: true,
    obscured: false,
    rect: { x: 0, y: 0, w: 160, h: 40 },
    pointer: true,
    inAdContainer: false,
    chrome: null,
    hintMatch: false,
    dataAttrs: '',
    ...partial,
  };
}

const score = (p: Partial<RawCandidate>) => scoreCandidate(cand(p), ctx).score;

test('recognises proceed-style buttons in many wordings and languages', () => {
  for (const text of [
    'Get Link',
    'GET LINK »',
    'Continue',
    'Proceed',
    'Verify',
    'Click here to continue',
    'Skip Ad',
    'Go to link',
    'Next Step',
    'Lanjutkan',
    'Continuar',
    'Obtener enlace',
    'Weiter',
    'Продолжить',
    'जारी रखें',
  ]) {
    assert.ok(score({ tag: 'button', text }) >= ACTIONABLE_THRESHOLD, `${text} should be actionable`);
  }
  assert.ok(score({ tag: 'a', ariaLabel: 'Get Link', href: 'https://dest.example/' }) >= ACTIONABLE_THRESHOLD, 'icon link with aria-label');
  assert.ok(score({ tag: 'input', type: 'submit', text: 'Proceed' }) >= ACTIONABLE_THRESHOLD, 'input submit');
});

test('get-link style buttons outrank generic continue buttons', () => {
  assert.ok(score({ tag: 'a', text: 'Get Link', className: 'btn btn-success get-link' }) > score({ tag: 'button', text: 'Continue' }));
});

test('demotes distractors: ads, navigation, social, login, blog chrome', () => {
  for (const text of [
    'Close',
    'Login',
    'Sign Up',
    'Share on Facebook',
    'Privacy Policy',
    'Home',
    'Next Post »',
    'Read more',
    'Continue reading',
    'Allow notifications',
  ]) {
    assert.ok(score({ text, tag: 'a', href: 'https://blog.example/x' }) < ACTIONABLE_THRESHOLD, `${text} should not be actionable`);
  }
  assert.ok(
    score({ text: 'Continue', inAdContainer: true, href: 'https://ads.example/x' }) < ACTIONABLE_THRESHOLD,
    'decoy inside ad container',
  );
  assert.ok(score({ text: 'Continue', href: 'https://www.popads.net/click' }) < ACTIONABLE_THRESHOLD, 'link to ad network');
  assert.ok(score({ text: 'Get Link', chrome: 'footer' }) < score({ text: 'Get Link' }));
  assert.ok(
    score({ text: 'How to save money in 2026: the complete beginner guide to budgeting and investing wisely' }) < ACTIONABLE_THRESHOLD,
  );
});

test('rewards links back into the shortener flow and penalises repeated attempts', () => {
  const base = score({ text: 'Continue', href: 'https://elsewhere.example/x' });
  const flow = score({ text: 'Continue', href: 'https://arolinks.com/abc' });
  assert.ok(flow > base);
  const tried = scoreCandidate(cand({ text: 'Continue', tag: 'button' }), { ...ctx, attempts: new Map([['button|continue||', 2]]) }).score;
  assert.ok(tried < score({ text: 'Continue', tag: 'button' }));
});

test('never treats human attestation controls as actionable', () => {
  assert.ok(isHumanAttestation("I'm not a robot"));
  assert.ok(isHumanAttestation('Verify you are human'));
  assert.ok(!isHumanAttestation('Verify'));
  assert.ok(score({ tag: 'button', text: "I'm not a robot" }) < 0);
});

test('label normalisation keeps non-Latin scripts', () => {
  assert.equal(normalizeLabel('  Get   LINK!! »'), 'get link');
  assert.equal(normalizeLabel('Продолжить →'), 'продолжить');
});
