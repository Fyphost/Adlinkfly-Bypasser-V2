/**
 * Scripts injected into every page before any site script runs.
 *
 * `captchaRenderHook` observes (never alters the behaviour of) the explicit
 * `render()` APIs of reCAPTCHA, hCaptcha and Turnstile. Every container a
 * widget is rendered into — including invisible widgets bound to a button from
 * script — is tagged with `data-agent-captcha-bound`, so the page probe can
 * tell "a CAPTCHA library is merely loaded" (e.g. passive reCAPTCHA v3) apart
 * from "this action is protected by a CAPTCHA". Must be fully self-contained.
 */
export const CAPTCHA_BOUND_ATTR = 'data-agent-captcha-bound';

export function captchaRenderHook(): void {
  const ATTR = 'data-agent-captcha-bound';
  const MARK = '__agentRenderHooked';
  const w = window as unknown as Record<string, unknown>;

  const tag = (container: unknown, params?: unknown): void => {
    try {
      const el = typeof container === 'string' ? document.getElementById(container) : container;
      const target = el && typeof (el as Element).setAttribute === 'function' ? (el as Element) : document.documentElement;
      target.setAttribute(ATTR, '1');
      // Record the public parameters (site key, action, size) so the page probe can read them
      // without us ever altering the widget's behaviour.
      if (params && typeof params === 'object') {
        const p = params as Record<string, unknown>;
        const sitekey = p.sitekey ?? p.siteKey ?? p.sitekeyv2;
        if (typeof sitekey === 'string') target.setAttribute('data-agent-sitekey', sitekey);
        if (typeof p.action === 'string') target.setAttribute('data-agent-captcha-action', p.action);
        if (p.size === 'invisible') target.setAttribute('data-agent-captcha-size', 'invisible');
      }
    } catch {
      /* never interfere with the page */
    }
  };

  const wrapRender = (fn: unknown): unknown => {
    if (typeof fn !== 'function' || (fn as unknown as Record<string, unknown>)[MARK]) return fn;
    const original = fn as (...args: unknown[]) => unknown;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      tag(args[0], args[1]);
      return original.apply(this, args);
    };
    (wrapped as unknown as Record<string, unknown>)[MARK] = true;
    return wrapped;
  };

  /** Intercepts assignments of `lib.render` (and `lib.enterprise.render`). */
  const hookLibrary = (lib: unknown): void => {
    if (!lib || (typeof lib !== 'object' && typeof lib !== 'function')) return;
    const obj = lib as Record<string, unknown>;
    if (obj[MARK]) return;
    try {
      Object.defineProperty(obj, MARK, { value: true, enumerable: false });
      let current = wrapRender(obj.render);
      Object.defineProperty(obj, 'render', {
        configurable: true,
        enumerable: true,
        get: () => current,
        set: (v: unknown) => {
          current = wrapRender(v);
        },
      });
      if (obj.enterprise) hookLibrary(obj.enterprise);
    } catch {
      /* frozen / non-configurable: fall back to polling below */
    }
  };

  for (const name of ['grecaptcha', 'hcaptcha', 'turnstile']) {
    try {
      let value = w[name];
      if (value) hookLibrary(value);
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        get: () => value,
        set: (v: unknown) => {
          value = v;
          hookLibrary(v);
        },
      });
    } catch {
      /* ignore */
    }
  }

  // Safety net for libraries that redefine properties with defineProperty.
  let polls = 0;
  const timer = setInterval(() => {
    for (const name of ['grecaptcha', 'hcaptcha', 'turnstile']) {
      const lib = w[name] as Record<string, unknown> | undefined;
      if (lib && typeof lib.render === 'function' && !(lib.render as unknown as Record<string, unknown>)[MARK]) {
        try {
          lib.render = wrapRender(lib.render);
        } catch {
          /* ignore */
        }
      }
    }
    if (++polls > 600) clearInterval(timer);
  }, 100);
}
