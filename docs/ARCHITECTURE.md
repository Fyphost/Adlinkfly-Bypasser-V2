# Architecture

```
            ┌──────────────────────────── Node.js process ─────────────────────────────┐
 client ──► │ api/server  auth · rate limit · validation · request log · CORS · headers│
            │      │                                                                     │
            │ service/resolverService  URL policy → module match → DNS pre-check        │
            │      │                   cache · in-flight de-dup · async job store       │
            │ queue/jobQueue           bounded concurrency · load shedding · deadlines   │
            │      │                                                                     │
            │ browser/browserManager   1 Chromium · fresh context per job · recycling    │
            │      │                   crash detection · route guard                     │
            │ agent/agent  ── observe (pageProbe) → decide (module, classifier,          │
            │      │          scoring, AI advisor) → act (click/wait/scroll/goto)        │
            │ extraction/  unwrap wrappers · follow redirectors · strip tracking         │
            │                                                                            │
            │ security/egressProxy ◄── ALL Chromium traffic (HTTP + CONNECT)             │
            │      └─ security/resolver: DNS → validate every IP → connect to pinned IP  │
            └────────────────────────────────────────────────────────────────────────────┘
```

| Directory | Responsibility |
| --- | --- |
| `src/api` | HTTP server and routing (`server.ts`), API-key auth (`auth.ts`), token-bucket limiter (`rateLimiter.ts`), body parsing / client IP / request ids (`http.ts`), response shapes (`responses.ts`) |
| `src/service` | Orchestration (`resolverService.ts`), LRU+TTL cache, async job store |
| `src/queue` | Job queue: concurrency, queue limit, queue timeout, job deadline, cancellation |
| `src/browser` | Browser lifecycle, hardened per-job contexts, ad-network list |
| `src/agent` | DOM probe, scoring, page classification, agent loop, AI advisor |
| `src/extraction` | Destination finalisation, wrapper unwrapping, SSRF-safe redirect follower |
| `src/security` | IP classification, URL policy, validating DNS resolver, egress proxy |
| `src/shorteners` | Module contract, registry, AdLinkFly platform logic, arolinks and generic modules |
| `src/errors.ts` | Error catalogue (code → HTTP status, resolution status, message) |
| `src/config.ts` | Environment parsing and validation |

## Request lifecycle

1. **API**: authenticate, rate-limit, parse and validate the body.
2. **Service**: normalise the URL, then run the URL policy (scheme, credentials, length, port, internal names, private IP literals, deny-list). Match a shortener module (`422 UNSUPPORTED_SHORTENER` if none). Resolve DNS and reject private answers. Check the cache. Join an identical in-flight job if one exists.
3. **Queue**: wait for a slot, or fail fast with `503`. The job gets an `AbortSignal` that fires on its deadline or when the client disconnects.
4. **Browser**: create a new incognito context with its own egress-proxy credentials, `acceptDownloads: false`, blocked service workers, no permissions, and a route guard.
5. **Agent**: run the loop below until there is a destination or an error.
6. **Extraction**: unwrap wrappers, follow known redirectors, strip tracking parameters, apply the destination deny-list. If the destination is another supported short link, resolve it too, up to `MAX_CHAIN_DEPTH`.
7. **Cleanup**: always close the context and the egress session. The slot is released only after cleanup has finished.

## The agent loop

Each step (bounded by `MAX_STEPS`):

1. **Evidence check.** Has the network already revealed the destination? Sources include the platform API JSON (AdLinkFly `/links/go`, plus any `form#go-link` action URL learned from the page), a download, or a non-HTML document.
2. **Observe.** `pageProbe` runs inside the main frame and inside same-site iframes. It collects:
   - every visible clickable element (links, buttons, inputs, `role=button`, `onclick` elements, and `cursor:pointer` elements with short text), with label, attributes, geometry, whether it is covered by another element, and whether it sits in an ad container or nav/header/footer;
   - countdowns, from timer elements and from text such as "wait 10 seconds";
   - CAPTCHA and challenge signals;
   - AdLinkFly markers, meta refresh, forms and link hosts.

   Elements are tagged with a random data attribute so the agent can address them precisely later.
3. **Module decision.** The shortener module can recognise known states. For AdLinkFly: the released `a.get-link` is the destination, a running `form#go-link` countdown means wait, and a CAPTCHA-free `form#link-view` means submit it.
4. **Human verification.** If a challenge is detected, stop and report it (see the policy below).
5. **Error pages.** Expired, missing or banned links, HTTP 404/410/5xx, anti-adblock walls, and redirects back to the shortener's home page.
6. **Destination or intermediate?** A page on a new host gets an *intermediate score* from several signals: platform markers, a countdown, a strong action button, links or forms back into the flow, link-locker phrases ("step 1/3", "your link is ready", "scroll down"…), meta refresh, and hidden actions. Below the threshold the page is the destination, after a settle check for late JS redirects. If AI is configured, ambiguous pages are confirmed with the model. Pages above the threshold are recorded as flow hosts.
7. **Act**, in this order:
   1. the module's decision;
   2. wait for a running countdown (stalls are detected);
   3. click the best candidate with score ≥ 5. After repeated failed clicks on a link, navigate to its `href` directly.
   4. Fallbacks:
      - meta refresh;
      - wait for disabled strong buttons;
      - scroll (reveals scroll-gated buttons);
      - wait for loading or hidden content;
      - wait for late iframes;
      - the AI advisor;
      - a weak candidate, tried once.
   5. Otherwise fail with `NO_ACTION_FOUND`.

**Clicks.** Clicks use Playwright's trusted input events. If an overlay covers the element, the agent retries with a forced click and then a DOM `click()`. Each click registers an *expected pop-up*. A new tab is adopted when its URL matches the clicked link or lands on a flow host; this handles `target=_blank` and tab-under tricks. Every other pop-up is closed. Dialogs are accepted and their text is kept for error messages.

**Loop protection.** Every click attempt is counted per page and lowers that element's score. Arrivals at the same URL are counted (`REDIRECT_LOOP`), unchanged pages are detected, and the step and wait budgets cap total work.

### Candidate scoring

The score of an element is the sum of independent signals. The weights live in `src/agent/scoring.ts`.

- **Label** (text, aria-label, title or img alt), normalised so non-Latin scripts survive. The strongest positive phrase counts, with a small bonus for several matches:
  - "get link" scores +11;
  - "continue", "proceed", "verify", "skip ad", "unlock", "next" score +5 to +10;
  - equivalents in Indonesian, Spanish, Portuguese, French, German, Turkish, Russian and Hindi are included.
- **Negative phrases:** close, login, share, privacy, home, "next post", "read more", "download now" bait, and others. Humanity attestation ("I'm not a robot") scores −40.
- **Attributes:** `get-link`, `continue` and `btn` tokens add points. `ad`, `banner`, `social`, `nav`, `footer` and similar subtract.
- **Link target:** a link back into the flow scores +4. A link to a known ad network scores −15. A self-link scores −3.
- **Context:** inside an ad container −8; inside nav, header, footer or aside −4; covered by another element −1.
- **Geometry:** element size; tiny elements score lower.
- **Module hints:** preferred selectors add +6.
- **History:** −4 per previous attempt.

### Human-verification policy

The agent **never** interacts with a CAPTCHA or challenge. It stops and reports `HUMAN_VERIFICATION_REQUIRED` on any of these:

- a visible reCAPTCHA, hCaptcha, Turnstile, Arkose or GeeTest widget;
- a text or image CAPTCHA;
- a Cloudflare interstitial that has not cleared on its own within `CHALLENGE_AUTO_WAIT_MS`;
- an AdLinkFly `link-view` form with a CAPTCHA provider;
- an invisible CAPTCHA bound to the action button;
- a button asking the visitor to confirm being human;
- strong text cues ("verify you are human", "complete the security check", …);
- the AI advisor answering `blocked`.

A plain "Verify" button that is just a navigation step, with no challenge attached, is treated like any other button. The agent waits out countdowns and never changes them.

## Security model

- **Egress proxy (`security/egressProxy.ts`).** The browser can reach the network only through a loopback proxy that needs per-job credentials. The browser-level proxy has none, so stray traffic fails closed.
  - The proxy resolves DNS itself and rejects a host if *any* of its addresses is private or reserved: IPv4 private, loopback, link-local, CGNAT, multicast and reserved ranges; IPv6 ULA, link-local and multicast; IPv4-mapped, NAT64 and 6to4 embeddings.
  - It then connects to exactly the address it validated, which closes the DNS-rebinding window.
  - It applies to redirects, sub-resources, iframes, WebSockets and pop-ups alike.
  - Per-job request and byte budgets are enforced, and closing a job tears down its sockets.
- **Route guard.** A second, synchronous layer inside the browser context. It blocks private IP literals, internal names and disallowed ports before a request even reaches the proxy, and records the reason.
- **Browser hardening.**
  - Every job gets a fresh incognito context. Downloads are off, service workers are blocked, and no permissions are granted.
  - Chromium's popup blocker is on.
  - WebRTC is restricted to proxied connections, and QUIC and DNS prefetch are disabled.
  - The OS sandbox can be enabled with `BROWSER_SANDBOX`.
- **API.**
  - API keys can be stored as SHA-256 digests and are compared in constant time.
  - Per-key rate limits, auth-failure lockout per IP, a body size limit and strict JSON validation.
  - Security headers (`nosniff`, `CSP default-src 'none'`, `no-store`, `DENY` framing).
  - Structured logs with secrets redacted and URL logging configurable.
- **AI advisor.** Page content is passed as untrusted data and answers are limited to a closed set of validated actions. Human-verification controls are refused regardless of what the model answers.

## Adding a shortener module

1. Create `src/shorteners/<name>.ts`.
   - For an AdLinkFly-based site, reuse the platform logic:

     ```ts
     import { createAdlinkflyModule } from './adlinkfly.ts';

     export const exampleModule = createAdlinkflyModule({
       id: 'example',
       name: 'Example Links',
       domains: ['example-links.com'],
       hints: {
         positivePatterns: [{ re: /\bopen my file\b/, w: 9, label: 'example-open' }],
         preferredSelectors: ['#final-btn'],
         apiPathPatterns: [/\/api\/release$/],
       },
       limits: { maxSteps: 40 },
     });
     ```

   - For a different platform, implement `ShortenerModule` (`src/shorteners/types.ts`) directly. Your `decide(snapshot, ctx)` hook returns `destination`, `wait`, `click`, `goto` or `fail` for the page states it recognises. Return `null` for anything else and the generic agent takes over.
2. Register it in `BUILTIN_MODULES` (`src/shorteners/registry.ts`), or pass it through `createApp(config, { extraModules: [...] })`.
3. Add a scenario to `test/helpers/mockSites.ts` and a test in `test/integration/flows.test.ts`.

Domains that run stock AdLinkFly need no code at all: add them to `ADLINKFLY_EXTRA_DOMAINS`.
