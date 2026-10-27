/**
 * AdLinkFly platform support.
 *
 * AdLinkFly (CakePHP) link pages share a recognisable structure:
 *   - `form#link-view`  : optional first step, usually CAPTCHA protected;
 *   - `form#go-link`    : hidden form (with `ad_form_data`) that the page's own
 *                         script POSTs to `/links/go` via AJAX once the
 *                         countdown (`app_vars.counter_value`) has elapsed;
 *   - `a.get-link`      : button that receives the destination URL and loses
 *                         its `disabled` class when the link is released.
 * Many operators add custom "blog" intermediate pages before that final step;
 * those are handled by the generic agent heuristics.
 *
 * The module never manipulates timers or forges requests: it waits for the
 * page's own countdown, then reads the released link.
 */
import type { ModuleContext, ModuleDecision, ShortenerHints, ShortenerModule } from './types.ts';
import type { PageSnapshot } from '../agent/types.ts';
import { hostOf } from '../agent/scoring.ts';

export const ADLINKFLY_HINTS: ShortenerHints = {
  preferredSelectors: ['a.get-link:not(.disabled)', 'form#link-view [type=submit]', 'form#link-view button', '.skip-ad a', 'a.skip-ad'],
  apiPathPatterns: [/\/links\/go\/?$/i],
};

function sameDocument(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    x.hash = '';
    y.hash = '';
    return x.href === y.href;
  } catch {
    return false;
  }
}

export function isAdlinkflyPage(snap: PageSnapshot): boolean {
  const m = snap.markers;
  return m.goLinkForm || m.adFormData || m.linkViewForm || (!!m.getLink && (m.counterValue !== null || m.goLinkForm));
}

export function adlinkflyDecide(snap: PageSnapshot, ctx: ModuleContext): ModuleDecision | null {
  if (!isAdlinkflyPage(snap) && !snap.markers.getLink) return null;
  const m = snap.markers;
  const gl = m.getLink;

  if (gl && !gl.disabled && gl.href && /^https?:/i.test(gl.href) && !sameDocument(gl.href, snap.url)) {
    const h = hostOf(gl.href);
    if (h && (ctx.isShortenerHost(h) || ctx.isFlowHost(h))) {
      // Some operators chain several AdLinkFly-style pages: the released link is the next step.
      return gl.agentId
        ? { type: 'click', agentId: gl.agentId, reason: 'AdLinkFly get-link leads to the next step of the flow' }
        : { type: 'goto', url: gl.href, reason: 'AdLinkFly get-link leads to the next step of the flow' };
    }
    if (h) return { type: 'destination', url: gl.href, confidence: 0.9, source: 'adlinkfly_get_link' };
  }

  if (m.goLinkForm) {
    const fromTimers = snap.countdowns.reduce((mx, c) => Math.max(mx, c.value), 0);
    const counter = Math.max(m.counterValue ?? 0, fromTimers);
    return {
      type: 'wait',
      reason: 'waiting for the AdLinkFly countdown to release the destination link',
      maxMs: (Math.min(counter, 900) + 20) * 1000,
      requiredMs: counter * 1000,
    };
  }

  if (m.linkViewForm) {
    // CAPTCHA-free variant (CAPTCHA variants are stopped earlier by the challenge detector).
    const btn = snap.candidates.find((c) => c.formId === 'link-view' && !c.disabled);
    if (btn) return { type: 'click', agentId: btn.agentId, reason: 'AdLinkFly link-view continue button' };
  }
  return null;
}

export interface AdlinkflyModuleOptions {
  id: string;
  name: string;
  domains: string[];
  description?: string;
  hints?: ShortenerHints;
  limits?: ShortenerModule['limits'];
}

/** Builds a module for an AdLinkFly-based shortener. */
export function createAdlinkflyModule(options: AdlinkflyModuleOptions): ShortenerModule {
  const hints: ShortenerHints = {
    positivePatterns: [...(options.hints?.positivePatterns ?? [])],
    negativePatterns: [...(options.hints?.negativePatterns ?? [])],
    preferredSelectors: [...(ADLINKFLY_HINTS.preferredSelectors ?? []), ...(options.hints?.preferredSelectors ?? [])],
    apiPathPatterns: [...(ADLINKFLY_HINTS.apiPathPatterns ?? []), ...(options.hints?.apiPathPatterns ?? [])],
  };
  return {
    id: options.id,
    name: options.name,
    platform: 'adlinkfly',
    description: options.description ?? `AdLinkFly-based shortener (${options.domains.join(', ')})`,
    domains: options.domains,
    hints,
    limits: options.limits,
    decide: adlinkflyDecide,
  };
}
