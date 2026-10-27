/**
 * In-page DOM probe. This function is serialised by Playwright and executed
 * inside each relevant frame, so it MUST be fully self-contained (no imports,
 * no closures over module scope).
 *
 * It inspects the DOM the way a human would look at a page: which elements are
 * visible and clickable, what they say, where they are, whether something
 * covers them, whether a countdown is running, whether a CAPTCHA/challenge is
 * shown and whether well-known platform structures (AdLinkFly) are present.
 * Interactive elements are tagged with a private data attribute so the agent
 * can address them precisely afterwards without brittle CSS selectors.
 */
import type { ProbeResult } from './types.ts';

export interface ProbeOptions {
  attr: string;
  maxCandidates: number;
  textLimit: number;
  hintSelectors: string[];
}

export function pageProbe(opts: ProbeOptions): ProbeResult {
  const ATTR = opts.attr;
  const doc = document;
  const win = window as unknown as Record<string, unknown> & Window;
  const norm = (s: string | null | undefined): string => (s || '').replace(/\s+/g, ' ').trim();
  const vw = win.innerWidth || 1366;
  const vh = win.innerHeight || 768;

  const seqKey = `${ATTR}_seq`;
  const pfxKey = `${ATTR}_pfx`;
  if (!win[pfxKey]) win[pfxKey] = Math.random().toString(36).slice(2, 7);
  if (typeof win[seqKey] !== 'number') win[seqKey] = 0;
  const nextId = (): string => {
    win[seqKey] = (win[seqKey] as number) + 1;
    return `${win[pfxKey] as string}-${win[seqKey] as number}`;
  };

  const isVisible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const anyEl = el as unknown as { checkVisibility?: (o: unknown) => boolean };
    if (typeof anyEl.checkVisibility === 'function') {
      if (!anyEl.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    } else {
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
    }
    if (r.right + win.scrollX < 0 || r.bottom + win.scrollY < 0) return false;
    if (r.left > Math.max(doc.documentElement.scrollWidth, vw) + 50) return false;
    return true;
  };

  const AD_TOKEN =
    /(^|[\s_-])(ad|ads|adv|advert|adverts|advertisement|adsbygoogle|banner|banners|sponsor|sponsored|promo|popunder|adbox|ad-slot|adslot)([\s_\d-]|$)/i;

  const ancestorContext = (el: Element): { ad: boolean; chrome: string | null } => {
    let ad = false;
    let chrome: string | null = null;
    let cur: Element | null = el.parentElement;
    for (let depth = 0; cur && depth < 8; depth++, cur = cur.parentElement) {
      const tag = cur.tagName.toLowerCase();
      const idc = `${cur.id || ''} ${typeof cur.className === 'string' ? cur.className : ''}`;
      if (!ad && (AD_TOKEN.test(idc) || tag === 'ins')) ad = true;
      if (!chrome) {
        const role = cur.getAttribute('role');
        if (tag === 'nav' || role === 'navigation') chrome = 'nav';
        else if (tag === 'header' || role === 'banner') chrome = 'header';
        else if (tag === 'footer' || role === 'contentinfo') chrome = 'footer';
        else if (tag === 'aside' || role === 'complementary') chrome = 'aside';
      }
    }
    return { ad, chrome };
  };

  const elementText = (el: Element): string => {
    const tag = el.tagName;
    if (tag === 'INPUT') return norm((el as HTMLInputElement).value || el.getAttribute('alt') || '');
    let t = norm((el as HTMLElement).innerText || el.textContent || '');
    if (!t) {
      const img = el.querySelector('img[alt]');
      if (img) t = norm(img.getAttribute('alt'));
    }
    if (!t) {
      const svgTitle = el.querySelector('svg title');
      if (svgTitle) t = norm(svgTitle.textContent);
    }
    return t.slice(0, 200);
  };

  const isDisabled = (el: Element): boolean => {
    if ((el as HTMLButtonElement).disabled === true) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    const cls = typeof el.className === 'string' ? el.className : '';
    if (/(^|\s)(disabled|is-disabled|btn-disabled)(\s|$)/i.test(cls)) return true;
    const cs = getComputedStyle(el);
    return cs.pointerEvents === 'none';
  };

  const hintMatch = (el: Element): boolean => {
    for (const sel of opts.hintSelectors) {
      try {
        if (el.matches(sel)) return true;
      } catch {
        /* invalid selector supplied by a module: ignore */
      }
    }
    return false;
  };

  const SELECTOR =
    'a[href], button, input[type=submit], input[type=button], input[type=image], [role=button], [role=link], [onclick], summary';
  const collected = new Set<Element>();
  const ordered: Element[] = [];
  doc.querySelectorAll(SELECTOR).forEach((el) => {
    if (ordered.length < 4000) {
      collected.add(el);
      ordered.push(el);
    }
  });
  // Elements made clickable purely through CSS/JS listeners (cursor:pointer, short text).
  if (doc.body) {
    const all = doc.body.getElementsByTagName('*');
    const pointerTags = new Set([
      'DIV',
      'SPAN',
      'P',
      'LI',
      'IMG',
      'I',
      'B',
      'STRONG',
      'CENTER',
      'FONT',
      'LABEL',
      'H1',
      'H2',
      'H3',
      'H4',
      'SVG',
      'EM',
    ]);
    for (let i = 0; i < all.length && i < 8000; i++) {
      const el = all[i]!;
      if (collected.has(el) || !pointerTags.has(el.tagName.toUpperCase())) continue;
      const tc = el.textContent || '';
      if (tc.length > 80) continue;
      const cs = getComputedStyle(el);
      if (cs.cursor !== 'pointer') continue;
      const parent = el.parentElement;
      if (parent && getComputedStyle(parent).cursor === 'pointer') continue; // inherited pointer
      if (el.closest(SELECTOR)) continue;
      collected.add(el);
      ordered.push(el);
    }
  }

  const candidates: ProbeResult['candidates'] = [];
  let hiddenStrong = 0;
  const STRONG = /\b(get link|continue|proceed|verify|next|skip|unlock|go to link|open link)\b/i;
  for (const el of ordered) {
    if (candidates.length >= opts.maxCandidates) break;
    // Skip elements nested inside another clickable element (keep the outer one).
    const outer = el.parentElement ? el.parentElement.closest('a[href], button') : null;
    if (outer && collected.has(outer)) continue;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') {
      const raw = el.getAttribute('href') || '';
      if (/^(mailto:|tel:|sms:|whatsapp:)/i.test(raw)) continue;
    }
    if (!isVisible(el)) {
      if (STRONG.test(norm(el.textContent).slice(0, 60))) hiddenStrong++;
      continue;
    }
    const r = el.getBoundingClientRect();
    const inViewport = r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
    let obscured = false;
    if (inViewport) {
      const cx = Math.min(Math.max(r.left + r.width / 2, 0), vw - 1);
      const cy = Math.min(Math.max(r.top + r.height / 2, 0), vh - 1);
      const hit = doc.elementFromPoint(cx, cy);
      obscured = !!hit && hit !== el && !el.contains(hit) && !hit.contains(el);
    }
    let agentId = el.getAttribute(ATTR);
    if (!agentId) {
      agentId = nextId();
      el.setAttribute(ATTR, agentId);
    }
    const ctx = ancestorContext(el);
    const form = (el as HTMLButtonElement).form || el.closest('form');
    const hrefRaw = tag === 'a' ? el.getAttribute('href') : null;
    const dataAttrs: string[] = [];
    for (const a of Array.from(el.attributes)) {
      if (a.name.startsWith('data-') && a.name !== ATTR && dataAttrs.length < 4) {
        dataAttrs.push(`${a.name}=${a.value.slice(0, 40)}`);
      }
    }
    candidates.push({
      agentId,
      tag,
      type: el.getAttribute('type'),
      role: el.getAttribute('role'),
      text: elementText(el),
      ariaLabel: el.getAttribute('aria-label'),
      title: el.getAttribute('title'),
      alt: el.getAttribute('alt'),
      id: el.id || null,
      className: (typeof el.className === 'string' ? el.className : el.getAttribute('class') || '').slice(0, 200),
      name: el.getAttribute('name'),
      href: tag === 'a' ? (el as HTMLAnchorElement).href || null : null,
      rawHref: hrefRaw,
      target: el.getAttribute('target'),
      hasOnclick: el.hasAttribute('onclick'),
      formId: form ? form.id || form.getAttribute('name') || '__form' : null,
      formAction: form ? (form as HTMLFormElement).action || null : null,
      formMethod: form ? ((form as HTMLFormElement).method || 'get').toLowerCase() : null,
      disabled: isDisabled(el),
      inViewport,
      obscured,
      rect: { x: Math.round(r.left + win.scrollX), y: Math.round(r.top + win.scrollY), w: Math.round(r.width), h: Math.round(r.height) },
      pointer: getComputedStyle(el).cursor === 'pointer',
      inAdContainer: ctx.ad,
      chrome: ctx.chrome,
      hintMatch: hintMatch(el),
      dataAttrs: dataAttrs.join(' '),
    });
  }

  const bodyText = doc.body ? norm(doc.body.innerText || '') : '';

  // ---- Countdown detection -------------------------------------------------
  const countdowns: ProbeResult['countdowns'] = [];
  const UNIT = '(?:s\\b|sec\\b|secs\\b|seconds?|detik|segundos?|secondes?|sekunden|сек|सेकंड)';
  // Candidate timer elements are chosen by whole id/class tokens (not substrings: "account",
  // "discount" or "post-views-count" must not look like countdowns).
  const TIMER_TOKEN = /^(timers?|countdown\w*|counter|cdown|wait|waiting|waittime|seconds|secs|clock|ticker)$/;
  const NOT_TIMER_TOKEN =
    /^(views?|comments?|likes?|shares?|followers?|cart|badge|items?|downloads?|votes?|rating|stars?|price|visitors?|hits)$/;
  const timerTokens = (el: Element): { timer: boolean; excluded: boolean } => {
    const raw = `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
    const tokens = raw.split(/[^a-z0-9]+/).filter(Boolean);
    return {
      timer: tokens.some((t) => TIMER_TOKEN.test(t)) || raw.includes('count-down'),
      excluded: tokens.some((t) => NOT_TIMER_TOKEN.test(t)),
    };
  };
  let n = 0;
  doc.querySelectorAll('[id], [class]').forEach((el) => {
    if (n >= 40) return;
    const tk = timerTokens(el);
    if (!tk.timer || tk.excluded || !isVisible(el)) return;
    const t = norm((el as HTMLElement).innerText);
    if (!t || t.length > 60) return;
    let hasUnit = false;
    let value: number | null = null;
    const bare = /^(\d{1,4})$/.exec(t);
    const unit = new RegExp(`(\\d{1,4})\\s*${UNIT}`, 'i').exec(t);
    const clock = /^(\d{1,2}):(\d{2})$/.exec(t);
    if (bare) value = Number(bare[1]);
    else if (unit) {
      value = Number(unit[1]);
      hasUnit = true;
    } else if (clock) {
      value = Number(clock[1]) * 60 + Number(clock[2]);
      hasUnit = true;
    }
    if (value !== null) {
      countdowns.push({
        key: `el:${el.id || (typeof el.className === 'string' ? el.className : '') || el.tagName}:${n}`,
        value,
        source: 'element',
        hasUnit,
      });
      n++;
    }
  });
  const textPatterns = [
    new RegExp(`(?:wait|in|after|remaining|tunggu|espere|attendez|warten)\\D{0,25}?(\\d{1,4})\\s*${UNIT}`, 'gi'),
    new RegExp(`(\\d{1,4})\\s*${UNIT}\\s*(?:remaining|left|tersisa|restantes)`, 'gi'),
  ];
  const sample = bodyText.slice(0, 6000);
  textPatterns.forEach((re, pi) => {
    let k = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sample)) && k < 5) {
      countdowns.push({ key: `text:${pi}:${k}`, value: Number(m[1]), source: 'text', hasUnit: true });
      k++;
    }
  });

  // ---- Challenge / CAPTCHA signals ----------------------------------------
  const iframes: ProbeResult['iframes'] = [];
  doc.querySelectorAll('iframe').forEach((f) => {
    if (iframes.length >= 40) return;
    const r = f.getBoundingClientRect();
    iframes.push({
      src: (f.getAttribute('src') || '').slice(0, 300),
      visible: isVisible(f),
      w: Math.round(r.width),
      h: Math.round(r.height),
      title: (f.getAttribute('title') || '').slice(0, 80),
    });
  });
  const scripts = Array.from(doc.querySelectorAll('script[src]')).map((s) => s.getAttribute('src') || '');
  const providers = new Set<string>();
  const visibleWidgets = new Set<string>();
  const PROVIDERS: Array<[string, RegExp, string]> = [
    ['recaptcha', /google\.com\/recaptcha|recaptcha\.net|gstatic\.com\/recaptcha/i, '.g-recaptcha, #g-recaptcha, .grecaptcha-badge'],
    ['hcaptcha', /hcaptcha\.com/i, '.h-captcha'],
    ['turnstile', /challenges\.cloudflare\.com/i, '.cf-turnstile'],
    ['arkose', /arkoselabs\.com|funcaptcha\.com/i, '#FunCaptcha, [data-pkey]'],
    ['geetest', /geetest\.com|geevisit/i, '.geetest_holder, .geetest_panel'],
    ['solvemedia', /solvemedia\.com/i, '#adcopy-outer, #adcopy_challenge'],
  ];
  for (const [name, re, sel] of PROVIDERS) {
    if (scripts.some((s) => re.test(s)) || iframes.some((f) => re.test(f.src))) providers.add(name);
    let els: NodeListOf<Element> | null = null;
    try {
      els = doc.querySelectorAll(sel);
    } catch {
      els = null;
    }
    if (els && els.length > 0) {
      providers.add(name);
      els.forEach((el) => {
        const size = el.getAttribute('data-size');
        if (isVisible(el) && size !== 'invisible' && !(el as HTMLElement).classList.contains('grecaptcha-badge')) {
          const r = el.getBoundingClientRect();
          if (r.width >= 60 && r.height >= 30) visibleWidgets.add(name);
        }
      });
    }
    for (const f of iframes) {
      if (!re.test(f.src) || !f.visible || f.w < 60 || f.h < 30) continue;
      if (name === 'recaptcha' && /size=invisible/.test(f.src) && !/bframe/.test(f.src)) continue;
      visibleWidgets.add(name);
    }
  }
  // A CAPTCHA bound to the action control itself (invisible reCAPTCHA / hCaptcha on the button).
  const invisibleBound = !!doc.querySelector(
    'button.g-recaptcha, input.g-recaptcha, a.g-recaptcha, [data-sitekey][data-callback], .g-recaptcha[data-size="invisible"], button.h-captcha, [data-hcaptcha-widget-id]',
  );
  // Widgets rendered from script (grecaptcha/hcaptcha/turnstile.render), tagged by the init-script hook.
  const scriptBound = !!doc.querySelector('[data-agent-captcha-bound]');
  const title = doc.title || '';
  const cloudflareInterstitial =
    /^(just a moment|attention required|checking your browser|one more step|please wait\.\.\.)/i.test(title.trim()) ||
    !!doc.querySelector(
      '#challenge-form, #challenge-running, #cf-challenge-running, #challenge-stage, .cf-browser-verification, #cf-please-wait',
    ) ||
    typeof win['_cf_chl_opt'] !== 'undefined';
  if (cloudflareInterstitial) providers.add('cloudflare');
  let captchaInputs = 0;
  doc.querySelectorAll('input[name*="captcha" i], input[id*="captcha" i], input[placeholder*="captcha" i]').forEach((el) => {
    const t = (el.getAttribute('type') || 'text').toLowerCase();
    if (t !== 'hidden' && isVisible(el)) captchaInputs++;
  });
  let captchaImages = 0;
  doc.querySelectorAll('img[src*="captcha" i], img[alt*="captcha" i], img[id*="captcha" i]').forEach((el) => {
    if (isVisible(el)) captchaImages++;
  });
  const lower = bodyText.toLowerCase().slice(0, 8000);
  const CUES = [
    'verify you are human',
    'verify that you are human',
    'confirm you are human',
    'prove you are human',
    'prove you are not a robot',
    "i'm not a robot",
    'i am not a robot',
    'are you a robot',
    'complete the security check',
    'complete the captcha',
    'solve the captcha',
    'checking your browser',
    'checking if the site connection is secure',
    'press and hold',
    'human verification',
    'security verification',
  ];
  const textCues = CUES.filter((c) => lower.includes(c));

  // ---- Platform markers (AdLinkFly) ---------------------------------------
  const gl = doc.querySelector('a.get-link, a#get-link, .get-link a, a.getlink, a#getlink') as HTMLAnchorElement | null;
  let getLink: ProbeResult['markers']['getLink'] = null;
  if (gl) {
    const cls = typeof gl.className === 'string' ? gl.className : '';
    getLink = {
      href: gl.href || null,
      rawHref: gl.getAttribute('href'),
      disabled: /(^|\s)disabled(\s|$)/.test(cls) || gl.getAttribute('aria-disabled') === 'true',
      text: norm(gl.innerText || gl.textContent).slice(0, 80),
      visible: isVisible(gl),
      agentId: gl.getAttribute(ATTR),
    };
  }
  let counterValue: number | null = null;
  try {
    const av = win['app_vars'] as Record<string, unknown> | undefined;
    if (av && typeof av === 'object') {
      const cv = Number(av['counter_value']);
      if (Number.isFinite(cv)) counterValue = cv;
    }
  } catch {
    /* ignore */
  }

  // ---- Meta refresh, forms, links ------------------------------------------
  let metaRefresh: ProbeResult['metaRefresh'] = null;
  const meta = doc.querySelector('meta[http-equiv="refresh" i]');
  if (meta) {
    const content = meta.getAttribute('content') || '';
    const m = /^\s*(\d+(?:\.\d+)?)\s*(?:[;,]\s*(?:url\s*=\s*)?['"]?([^'"]+)['"]?)?/i.exec(content);
    if (m) {
      let target: string | null = null;
      if (m[2]) {
        try {
          target = new URL(m[2].trim(), location.href).href;
        } catch {
          target = null;
        }
      }
      metaRefresh = { delay: Number(m[1]), url: target };
    }
  }
  const forms: ProbeResult['forms'] = [];
  Array.from(doc.forms)
    .slice(0, 20)
    .forEach((f) => {
      forms.push({
        id: f.id || f.getAttribute('name') || null,
        action: f.action || '',
        method: (f.method || 'get').toLowerCase(),
        hiddenInputs: f.querySelectorAll('input[type=hidden]').length,
        fields: f.elements.length,
        visible: isVisible(f),
        hasSubmit: !!f.querySelector('[type=submit], button:not([type]), button[type=submit], input[type=image]'),
      });
    });
  const linkHosts: Record<string, number> = {};
  let ln = 0;
  doc.querySelectorAll('a[href]').forEach((a) => {
    if (ln++ > 1500) return;
    try {
      const h = new URL((a as HTMLAnchorElement).href).hostname;
      if (h) linkHosts[h] = (linkHosts[h] || 0) + 1;
    } catch {
      /* ignore */
    }
  });

  return {
    url: location.href,
    title: norm(title).slice(0, 200),
    readyState: doc.readyState,
    text: bodyText.slice(0, opts.textLimit),
    textLength: bodyText.length,
    candidates,
    hiddenStrongCandidates: hiddenStrong,
    countdowns,
    iframes,
    challenge: {
      providers: Array.from(providers),
      visibleWidgets: Array.from(visibleWidgets),
      invisibleBound,
      scriptBound,
      cloudflareInterstitial,
      captchaInputs,
      captchaImages,
      textCues,
    },
    markers: {
      goLinkForm: !!doc.querySelector('form#go-link'),
      goLinkAction: (doc.querySelector('form#go-link') as HTMLFormElement | null)?.action || null,
      linkViewForm: !!doc.querySelector('form#link-view'),
      adFormData: !!doc.querySelector('input[name="ad_form_data"]'),
      // AdLinkFly renders its CAPTCHA widget into #captchaShortlink; an empty container means CAPTCHA is off.
      captchaShortlink: (() => {
        const box = doc.querySelector('#captchaShortlink');
        return !!box && (box.children.length > 0 || (box.textContent || '').trim().length > 0);
      })(),
      getLink,
      counterValue,
    },
    metaRefresh,
    forms,
    linkHosts,
    scroll: { y: Math.round(win.scrollY), height: doc.documentElement.scrollHeight, viewport: vh },
  };
}

/** Lightweight probe used while waiting (countdowns / enablement). Self-contained. */
export function waitProbe(args: { attr: string; ids: string[] }): {
  url: string;
  enabled: string[];
  countdown: number[];
  strongVisible: number;
  getLinkHref: string | null;
  getLinkDisabled: boolean | null;
} {
  const STRONG = /\b(get link|continue|proceed|verify|next|skip|unlock|go to link|open link|click here)\b/i;
  let strongVisible = 0;
  document.querySelectorAll('a[href], button, input[type=submit], input[type=button], [role=button]').forEach((el) => {
    if (strongVisible > 20) return;
    const t = (el.tagName === 'INPUT' ? (el as HTMLInputElement).value : (el as HTMLElement).innerText || '').slice(0, 60);
    if (!STRONG.test(t)) return;
    const r = el.getBoundingClientRect();
    if (r.width > 1 && r.height > 1 && !(el as HTMLButtonElement).disabled) strongVisible++;
  });
  const enabled: string[] = [];
  for (const id of args.ids) {
    const el = document.querySelector(`[${args.attr}="${id}"]`);
    if (!el) continue;
    const cls = typeof el.className === 'string' ? el.className : '';
    const disabled =
      (el as HTMLButtonElement).disabled === true ||
      el.getAttribute('aria-disabled') === 'true' ||
      /(^|\s)(disabled|is-disabled|btn-disabled)(\s|$)/i.test(cls) ||
      getComputedStyle(el).pointerEvents === 'none';
    const r = el.getBoundingClientRect();
    if (!disabled && r.width > 1 && r.height > 1) enabled.push(id);
  }
  const countdown: number[] = [];
  const TIMER_TOKEN = /^(timers?|countdown\w*|counter|cdown|wait|waiting|waittime|seconds|secs|clock|ticker)$/;
  const NOT_TIMER_TOKEN =
    /^(views?|comments?|likes?|shares?|followers?|cart|badge|items?|downloads?|votes?|rating|stars?|price|visitors?|hits)$/;
  document.querySelectorAll('[id], [class]').forEach((el) => {
    if (countdown.length >= 10) return;
    const raw = `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
    const tokens = raw.split(/[^a-z0-9]+/).filter(Boolean);
    if (!(tokens.some((t) => TIMER_TOKEN.test(t)) || raw.includes('count-down')) || tokens.some((t) => NOT_TIMER_TOKEN.test(t))) return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    const t = ((el as HTMLElement).innerText || '').trim();
    const m = /^(\d{1,4})\b/.exec(t) ?? /(\d{1,4})\s*(?:s\b|sec|secs|seconds?|detik|segundos?)/i.exec(t);
    if (m && t.length < 60) countdown.push(Number(m[1]));
  });
  const gl = document.querySelector('a.get-link, a#get-link, .get-link a, a.getlink, a#getlink') as HTMLAnchorElement | null;
  return {
    url: location.href,
    enabled,
    countdown,
    strongVisible,
    getLinkHref: gl ? gl.href || null : null,
    getLinkDisabled: gl ? /(^|\s)disabled(\s|$)/.test(typeof gl.className === 'string' ? gl.className : '') : null,
  };
}
