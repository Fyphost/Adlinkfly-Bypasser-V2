/**
 * Page-state classification: human-verification challenges, error / expired
 * pages, anti-adblock walls, and "is this an intermediate page of the flow or
 * the final destination?".
 */
import type { PageSnapshot, ScoredCandidate } from './types.ts';
import { STRONG_THRESHOLD, candidateLabel, isHumanAttestation, hostOf } from './scoring.ts';

export interface ChallengeAssessment {
  blocking: boolean;
  /** Cloudflare-style interstitials may clear on their own without interaction. */
  interstitial: boolean;
  type: string | null;
  reason: string;
}

const STRONG_CHALLENGE_CUES = [
  'verify you are human',
  'verify that you are human',
  'confirm you are human',
  'prove you are human',
  'prove you are not a robot',
  "i'm not a robot",
  'i am not a robot',
  'complete the security check',
  'complete the captcha',
  'solve the captcha',
  'press and hold',
  'checking your browser',
  'checking if the site connection is secure',
];

/**
 * Decides whether the page requires a human to pass a CAPTCHA / challenge.
 * The agent never interacts with such challenges; it reports them instead.
 */
export function assessChallenge(snap: PageSnapshot): ChallengeAssessment {
  const c = snap.challenge;
  if (c.cloudflareInterstitial) {
    return { blocking: true, interstitial: true, type: 'cloudflare_challenge', reason: 'Cloudflare browser challenge page' };
  }
  if (c.visibleWidgets.length > 0) {
    const type = c.visibleWidgets[0]!;
    return { blocking: true, interstitial: false, type, reason: `visible ${type} challenge` };
  }
  if (c.captchaInputs > 0 || c.captchaImages > 0) {
    return { blocking: true, interstitial: false, type: 'text_captcha', reason: 'image/text CAPTCHA input' };
  }
  const captchaProvider = c.providers.find((p) => p !== 'cloudflare');
  if (c.scriptBound) {
    // The page explicitly rendered a CAPTCHA widget (visible or invisible) from script.
    return { blocking: true, interstitial: false, type: captchaProvider ?? 'captcha', reason: 'CAPTCHA widget rendered on the page' };
  }
  // AdLinkFly's first step (form#link-view) is CAPTCHA-protected when a provider is present or its
  // #captchaShortlink container holds a widget.
  if (snap.markers.linkViewForm && (captchaProvider || snap.markers.captchaShortlink)) {
    return {
      blocking: true,
      interstitial: false,
      type: captchaProvider ?? 'adlinkfly_captcha',
      reason: 'AdLinkFly CAPTCHA-protected link page',
    };
  }
  if (c.invisibleBound && captchaProvider) {
    return { blocking: true, interstitial: false, type: captchaProvider, reason: `${captchaProvider} bound to the continue action` };
  }
  const attest = snap.candidates.find((cand) => isHumanAttestation(candidateLabel(cand)));
  if (attest) {
    return {
      blocking: true,
      interstitial: false,
      type: 'human_attestation',
      reason: `page asks to confirm being human ("${candidateLabel(attest).slice(0, 40)}")`,
    };
  }
  const strongCue = c.textCues.find((t) => STRONG_CHALLENGE_CUES.includes(t));
  if (strongCue) {
    return { blocking: true, interstitial: false, type: captchaProvider ?? 'human_verification', reason: `page text: "${strongCue}"` };
  }
  return { blocking: false, interstitial: false, type: null, reason: '' };
}

export interface ErrorPageVerdict {
  code: 'LINK_NOT_FOUND' | 'LINK_EXPIRED' | 'ADBLOCK_WALL' | 'NAVIGATION_FAILED';
  detail: string;
}

const EXPIRED_RE =
  /\b(link|url|short ?link|short ?url|file|page)\b[^.!?\n]{0,30}\b(has|have|was|is|been)\b[^.!?\n]{0,15}\b(expired|deleted|removed|disabled|deactivated|suspended|banned|blocked|taken down)\b|\bno longer (available|active|exists?|valid)\b|\blink (has )?expired\b/i;
const NOT_FOUND_RE =
  /\b(link|url|short ?link|short ?url|alias|page)\b[^.!?\n]{0,20}\b(not found|does not exist|doesn t exist|doesn't exist|could not be found|cannot be found|is invalid)\b|\binvalid (link|url|short ?url|alias)\b|\b404\b[^.!?\n]{0,30}\bnot found\b|^404\b/i;
const ADBLOCK_RE =
  /\b(disable|turn off|deactivate|pause|whitelist)\b[^.!?\n]{0,30}\bad ?-?block(er)?s?\b|\bad ?-?block(er)? (is )?detected\b|\bplease allow ads\b/i;

export interface ErrorContext {
  onShortenerHost: boolean;
  startPath: string;
  path: string;
}

export function detectErrorPage(snap: PageSnapshot, ctx: ErrorContext): ErrorPageVerdict | null {
  const strong = snap.candidates.filter((c) => c.score >= STRONG_THRESHOLD).length;
  const hasMarkers = snap.markers.goLinkForm || snap.markers.adFormData || snap.markers.linkViewForm || !!snap.markers.getLink;
  if (snap.status !== null) {
    if (ctx.onShortenerHost && snap.status === 404 && !hasMarkers) {
      return { code: 'LINK_NOT_FOUND', detail: 'The shortener responded with HTTP 404 (link not found)' };
    }
    if (ctx.onShortenerHost && snap.status === 410) {
      return { code: 'LINK_EXPIRED', detail: 'The shortener responded with HTTP 410 (link gone)' };
    }
    if (snap.status >= 500 && strong === 0) {
      return { code: 'NAVIGATION_FAILED', detail: `The page responded with HTTP ${snap.status}` };
    }
    if (snap.status === 403 && strong === 0 && !hasMarkers) {
      return { code: 'NAVIGATION_FAILED', detail: 'Access to the page was denied (HTTP 403)' };
    }
  }
  if (strong > 0 || hasMarkers) return null;
  const textual = ctx.onShortenerHost || snap.textLength < 3000;
  const haystack = `${snap.title}\n${snap.text.slice(0, 3000)}`;
  if (ADBLOCK_RE.test(haystack)) {
    return { code: 'ADBLOCK_WALL', detail: 'The page demands that ad blocking be disabled' };
  }
  if (textual && EXPIRED_RE.test(haystack)) {
    return { code: 'LINK_EXPIRED', detail: 'The page reports that the link expired or was removed' };
  }
  if (textual && NOT_FOUND_RE.test(haystack)) {
    return { code: 'LINK_NOT_FOUND', detail: 'The page reports that the link does not exist' };
  }
  if (ctx.onShortenerHost && ctx.startPath !== '/' && ctx.path === '/') {
    return { code: 'LINK_NOT_FOUND', detail: 'The shortener redirected to its home page (unknown or removed alias)' };
  }
  return null;
}

const LOCKER_TEXT: RegExp[] = [
  /\b(your|the) (link|url|download link) (is|will be) (ready|generated|generating|available|unlocked)/i,
  /\bplease wait\b.{0,40}\b(link|seconds?|redirect)/i,
  /\bscroll down\b/i,
  /\bstep\s*\d+\s*(of|\/)\s*\d+\b/i,
  /\bclick (on )?(the )?(button|verify|continue|get link|link)\b.{0,20}\b(below|to continue|to proceed|to get)/i,
  /\bgenerat(e|ing) (the |your )?link\b/i,
  /\b(verify|continue|click) to (continue|proceed|get (the |your )?link)\b/i,
  /\byou (are being|will be) redirected\b/i,
  /\bdestination (link|page|url)\b/i,
  /\b(get|getting) (the |your )?link\b/i,
  /\bwait (for )?\d+ seconds?\b/i,
];

export interface FlowContext {
  isShortenerHost: (host: string) => boolean;
  isFlowHost: (host: string) => boolean;
}

export interface IntermediateAssessment {
  score: number;
  reasons: string[];
}

export const INTERMEDIATE_THRESHOLD = 6;

/** Scores how strongly a page looks like an intermediate step of a shortener flow. */
export function intermediateScore(snap: PageSnapshot, ctx: FlowContext): IntermediateAssessment {
  let score = 0;
  const reasons: string[] = [];
  const add = (w: number, r: string) => {
    score += w;
    reasons.push(`${r}(+${w})`);
  };
  if (ctx.isShortenerHost(snap.host)) add(10, 'shortener-host');
  const m = snap.markers;
  if (m.goLinkForm || m.adFormData || m.linkViewForm || m.getLink) add(10, 'platform-markers');
  if (snap.countdowns.some((c) => c.value > 0)) add(3, 'countdown');
  const strong = snap.candidates.filter((c) => c.score >= STRONG_THRESHOLD);
  if (strong.length > 0) add(3, 'strong-action');
  const linksBack = snap.candidates.some((c: ScoredCandidate) => {
    const h = hostOf(c.href);
    return !!h && h !== snap.host && (ctx.isShortenerHost(h) || ctx.isFlowHost(h)) && c.score >= 3;
  });
  if (linksBack) add(6, 'links-back-into-flow');
  const formBack = snap.probe.forms.some((f) => {
    const h = hostOf(f.action);
    return !!h && h !== snap.host && (ctx.isShortenerHost(h) || ctx.isFlowHost(h));
  });
  if (formBack) add(4, 'form-into-flow');
  if (Object.keys(snap.probe.linkHosts).some((h) => h !== snap.host && ctx.isShortenerHost(h))) add(2, 'mentions-shortener');
  let textHits = 0;
  const hay = `${snap.title}\n${snap.text.slice(0, 5000)}`;
  for (const re of LOCKER_TEXT) {
    if (textHits >= 2) break;
    if (re.test(hay)) {
      textHits++;
      add(3, 'locker-text');
    }
  }
  if (snap.probe.metaRefresh?.url) add(2, 'meta-refresh');
  if (snap.probe.hiddenStrongCandidates > 0) add(2, 'hidden-action');
  return { score, reasons };
}

const LOADING_RE = /\b(please wait|loading|generating|redirecting|processing|preparing)\b/i;

export function looksLoading(snap: PageSnapshot): boolean {
  return LOADING_RE.test(snap.title) || (snap.textLength < 4000 && LOADING_RE.test(snap.text.slice(0, 4000)));
}
