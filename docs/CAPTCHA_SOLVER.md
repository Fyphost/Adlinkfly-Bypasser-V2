# Adding an automatic CAPTCHA resolver

This guide explains the optional, pluggable **CAPTCHA‑solving tool** in the
resolver: how it is wired in, and how to extend it. It reuses the project's
existing patterns so the addition stays consistent with the rest of the service.

> **Status: implemented (disabled by default).** The tool described below now
> ships in the codebase and is enabled via `CAPTCHA_PROVIDER` (see
> [docs/CONFIGURATION.md](CONFIGURATION.md#captcha-solver-optional)). Supported
> backends: **2captcha** and **CapSolver**. Supported challenge families:
> reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile (widget with an extractable
> site key). The relevant code: `src/agent/captchaSolver.ts` (the service),
> site‑key capture in `src/agent/pageProbe.ts` + `src/browser/initScripts.ts`,
> the solve hook in `src/agent/agent.ts` (`trySolveChallenge`), and wiring in
> `src/app.ts` / `src/service/resolverService.ts`. The sections below document
> the design and the extension points for adding providers or challenge types.

> **Important — read this first**
>
> The agent is deliberately built to **detect and report** CAPTCHAs, never to
> solve them. When a page requires human verification the agent stops and
> returns `HUMAN_VERIFICATION_REQUIRED` (see `assessChallenge` in
> `src/agent/classifier.ts` and the gate in `src/agent/agent.ts`). The AI
> advisor's system prompt even forbids the model from touching CAPTCHAs.
>
> Automating CAPTCHA solving may violate the **terms of service** of the target
> sites and of CAPTCHA providers (reCAPTCHA, hCaptcha, Turnstile, …), and
> third‑party solving services raise their own legal, privacy, and cost
> considerations. Treat this as an **opt‑in capability that ships disabled by
> default**, keep the existing "report and stop" behaviour as the fallback, and
> only enable it where you are authorised to do so. This document shows how to
> wire it in cleanly; the decision to turn it on is yours.

---

## 1. How CAPTCHAs flow through the agent today

Understanding the current path tells you exactly where the new tool plugs in.

1. **Injection** — `src/browser/browserManager.ts` installs
   `captchaRenderHook()` (`src/browser/initScripts.ts`) via
   `context.addInitScript(...)` before any site script runs. The hook wraps the
   `render()` APIs of `grecaptcha` / `hcaptcha` / `turnstile` and tags the
   widget container with `data-agent-captcha-bound` (`CAPTCHA_BOUND_ATTR`). It
   only observes — it never extracts the sitekey.
2. **Detection** — on each step `observe()` runs `pageProbe` (`src/agent/pageProbe.ts`)
   inside the page and fills the `ChallengeSignals` struct
   (`src/agent/types.ts`): which providers are present, whether a widget is
   visible, whether it's script‑bound, Cloudflare interstitials, captcha
   inputs/images, and text cues. **It does not currently capture the sitekey or
   callback.**
3. **Decision** — `assessChallenge(snap)` (`src/agent/classifier.ts`) turns those
   signals into `{ blocking, interstitial, type, reason }`.
4. **The gate** — in `src/agent/agent.ts`, `loop()` reacts:

   ```ts
   const challenge = assessChallenge(snap);
   if (challenge.blocking) {
     if (challenge.interstitial && this.challengeWaitUsed < this.cfg.challengeAutoWaitMs) {
       await this.waitForInterstitial(snap);   // passively wait out Cloudflare
       continue;
     }
     this.record('human-verification', challenge.reason);
     this.fail('HUMAN_VERIFICATION_REQUIRED', `Human verification is required: ${challenge.reason}`, {
       verification_url: snap.url,
       challenge_type: challenge.type,
     });
   }
   ```

   **This `if (challenge.blocking)` branch is the single hook point.** A solver
   tries to solve *before* `this.fail(...)` is reached, and falls back to the
   existing failure on any error or when disabled.

The design we follow mirrors the **optional AI advisor** (`src/agent/aiAdvisor.ts`):
a plain interface, a `disabled*` no‑op, a provider implementation, a `create*`
factory gated by config, and a per‑job budget. Copy that shape and the result
will feel native to the codebase.

---

## 2. Overview of the change

Five edits plus one new file:

| # | File | Change |
| - | ---- | ------ |
| 1 | `src/config.ts`, `.env.example`, `docs/CONFIGURATION.md` | New `captcha` config section (mirrors the `ai` section) |
| 2 | `src/agent/captchaSolver.ts` *(new)* | `CaptchaSolver` interface, `disabledSolver`, a provider client, `createCaptchaSolver(...)` factory |
| 3 | `src/agent/types.ts`, `src/agent/pageProbe.ts`, `src/browser/initScripts.ts` | Capture the sitekey / action / callback into `ChallengeSignals` |
| 4 | `src/app.ts`, `src/service/resolverService.ts`, `src/agent/agent.ts` (`AgentOptions`) | Instantiate and thread the solver + per‑job budget through to the agent |
| 5 | `src/agent/agent.ts` (`loop()`) | Attempt a solve in the `challenge.blocking` branch, inject the token, then `continue` |

Keep every step gated so that **with the feature off, behaviour is byte‑for‑byte
identical to today.**

---

## 3. Step 1 — Configuration

Add a `captcha` section to `AppConfig` in `src/config.ts`, parsed with the same
`EnvReader` helpers (`str`/`int`/`bool`/`oneOf`/`optStr`) and the same
cross‑field validation style used by the `ai` section.

```ts
// Inside AppConfig
captcha: {
  provider: CaptchaProvider;        // 'none' | '2captcha' | 'capsolver' | ...
  apiKey: string | undefined;
  baseUrl: string;
  timeoutMs: number;                // per solve-request budget
  pollIntervalMs: number;           // for async solver APIs that poll a task id
  maxSolvesPerJob: number;          // 0 disables, mirrors ai.maxCallsPerJob
};
```

Parse it next to the `ai` block (roughly):

```ts
const captchaProvider = env.oneOf('CAPTCHA_PROVIDER', ['none', '2captcha', 'capsolver'], 'none');
const captchaEnabled = captchaProvider !== 'none';
const captcha = {
  provider: captchaProvider,
  apiKey: env.optStr('CAPTCHA_API_KEY'),
  baseUrl: env.str('CAPTCHA_BASE_URL', defaultCaptchaBaseUrl(captchaProvider)),
  timeoutMs: env.int('CAPTCHA_TIMEOUT_MS', 120_000, { min: 1_000 }),
  pollIntervalMs: env.int('CAPTCHA_POLL_INTERVAL_MS', 5_000, { min: 500 }),
  maxSolvesPerJob: env.int('CAPTCHA_MAX_SOLVES_PER_JOB', 0, { min: 0 }),
};
if (captchaEnabled && !captcha.apiKey) {
  env.problem('CAPTCHA_API_KEY', 'required when CAPTCHA_PROVIDER is set');
}
if (captchaEnabled && captcha.maxSolvesPerJob === 0) {
  env.problem('CAPTCHA_MAX_SOLVES_PER_JOB', 'must be > 0 to enable the solver');
}
```

> Note `CAPTCHA_TIMEOUT_MS` interacts with `JOB_TIMEOUT_MS` (default 150 s).
> External solves of image/interactive CAPTCHAs commonly take 10–60 s, so ensure
> the job deadline leaves room, or the job will time out mid‑solve.

Add the knobs to `.env.example` and a table to `docs/CONFIGURATION.md` (a
"CAPTCHA solver (optional)" section modelled on the "AI fallback (optional)"
one):

| Variable | Default | Description |
| --- | --- | --- |
| `CAPTCHA_PROVIDER` | `none` | Solving backend. `none` keeps the report‑and‑stop behaviour. |
| `CAPTCHA_API_KEY` | | Provider API key (required when enabled) |
| `CAPTCHA_BASE_URL` | *(per provider)* | Provider API base URL |
| `CAPTCHA_TIMEOUT_MS` | `120000` | Max time for one solve |
| `CAPTCHA_POLL_INTERVAL_MS` | `5000` | Poll interval for task‑based provider APIs |
| `CAPTCHA_MAX_SOLVES_PER_JOB` | `0` | Solves allowed per resolution. `0` disables the solver. |

---

## 4. Step 2 — The solver service (`src/agent/captchaSolver.ts`)

Model this file on `src/agent/aiAdvisor.ts`: interface + `disabled*` no‑op +
provider implementation + `create*` factory. The solver is provider‑agnostic;
the agent hands it a normalised task and gets back a token string.

```ts
import type { AppConfig } from '../config.ts';
import type { Logger } from '../logger.ts';

export type CaptchaKind = 'recaptcha-v2' | 'recaptcha-v3' | 'hcaptcha' | 'turnstile';

export interface CaptchaTask {
  kind: CaptchaKind;
  sitekey: string;
  pageUrl: string;
  action?: string;      // reCAPTCHA v3 action
  minScore?: number;    // reCAPTCHA v3
  invisible?: boolean;
}

export interface CaptchaSolution {
  token: string;        // the g-recaptcha-response / h-captcha-response / cf token
}

export interface CaptchaSolver {
  readonly enabled: boolean;
  solve(task: CaptchaTask, signal?: AbortSignal): Promise<CaptchaSolution | null>;
}

export const disabledSolver: CaptchaSolver = {
  enabled: false,
  solve: async () => null,
};

type FetchFn = typeof fetch;

/**
 * Example client for a task-based HTTP solving API (create task -> poll result).
 * Adapt the request/response shapes to your chosen provider. All provider I/O
 * goes through fetchImpl so it can be injected in tests (see AppOverrides).
 */
export class HttpCaptchaSolver implements CaptchaSolver {
  readonly enabled = true;
  private readonly cfg: AppConfig['captcha'];
  private readonly logger: Logger;
  private readonly fetchImpl: FetchFn;

  constructor(cfg: AppConfig['captcha'], logger: Logger, fetchImpl: FetchFn = fetch) {
    this.cfg = cfg;
    this.logger = logger.child({ component: 'captcha-solver', provider: cfg.provider });
    this.fetchImpl = fetchImpl;
  }

  async solve(task: CaptchaTask, signal?: AbortSignal): Promise<CaptchaSolution | null> {
    const timeout = AbortSignal.timeout(this.cfg.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const started = Date.now();
    try {
      const taskId = await this.createTask(task, combined);
      const token = await this.pollResult(taskId, combined);
      this.logger.info('captcha solved', { ms: Date.now() - started, kind: task.kind });
      return token ? { token } : null;
    } catch (err) {
      this.logger.warn('captcha solve failed', { ms: Date.now() - started, error: (err as Error).message });
      return null;   // fall back to HUMAN_VERIFICATION_REQUIRED
    }
  }

  private async createTask(task: CaptchaTask, signal: AbortSignal): Promise<string> {
    // POST to the provider's "create task" endpoint, mapping task.kind to the
    // provider's type (e.g. RecaptchaV2TaskProxyless / HCaptchaTaskProxyless /
    // TurnstileTaskProxyless) and returning the provider's task id.
    throw new Error('not implemented: map to your provider');
  }

  private async pollResult(taskId: string, signal: AbortSignal): Promise<string | null> {
    // Poll the "get task result" endpoint every cfg.pollIntervalMs until ready,
    // the combined signal aborts, or the provider reports failure.
    throw new Error('not implemented: map to your provider');
  }
}

export function createCaptchaSolver(cfg: AppConfig['captcha'], logger: Logger, fetchImpl?: FetchFn): CaptchaSolver {
  if (cfg.provider === 'none' || cfg.maxSolvesPerJob === 0) return disabledSolver;
  return new HttpCaptchaSolver(cfg, logger, fetchImpl);
}
```

> **Proxy / egress note.** Most solving providers solve "proxyless" from their
> own infrastructure, so the resulting token is tied to *their* IP, not the
> per‑job `EgressSession` proxy this service uses. Many sites accept this for
> reCAPTCHA/hCaptcha/Turnstile; some do not. If you need IP‑matched solving you
> must pass the job's egress proxy to the provider — out of scope here, but plan
> for it. All outbound solver calls bypass the browser, so they are **not**
> covered by `UrlPolicy`/SSRF checks; point `CAPTCHA_BASE_URL` only at trusted
> provider hosts.

---

## 5. Step 3 — Capture the sitekey (probe enrichment)

The solver needs the **sitekey** (and for v3 the action), which the probe does
not collect yet. Two complementary places to add it:

1. **`src/browser/initScripts.ts` — `captchaRenderHook()`**: the hook already
   intercepts `render(container, params)`. Extend `tag()` to also persist
   `params.sitekey`, `params.action`, and whether it's invisible onto the
   container element as data attributes, e.g.
   `data-agent-sitekey` / `data-agent-captcha-action`. This covers script‑rendered
   (incl. invisible) widgets.
2. **`src/agent/pageProbe.ts`**: for explicitly rendered widgets, read the
   standard attributes already in the DOM — `.g-recaptcha[data-sitekey]`,
   `.h-captcha[data-sitekey]`, `.cf-turnstile[data-sitekey]`,
   `[data-pkey]` (Arkose) — plus the enriched attributes from step 1.

Extend `ChallengeSignals` in `src/agent/types.ts` so the data reaches the agent:

```ts
export interface ChallengeSignals {
  // ...existing fields...
  sitekey?: string;
  captchaAction?: string;   // reCAPTCHA v3 action, if any
  invisible?: boolean;      // invisible widget bound to an action button
}
```

Treat everything read from the page as **untrusted** — the codebase is explicit
about this. Validate the sitekey shape (non‑empty, reasonable length, expected
charset) before sending it anywhere.

---

## 6. Step 4 — Wiring and the per‑job budget

Thread the solver exactly like the advisor:

- **`src/app.ts`** (composition root): build it next to the advisor and add it
  to `ResolverServiceDeps`.

  ```ts
  const captchaSolver = createCaptchaSolver(config.captcha, logger, overrides.captchaFetch);
  // ...pass captchaSolver into new ResolverService({ ... })
  ```

  Add an optional `captchaFetch?: FetchFn` to `AppOverrides` so tests can inject
  a fake provider, mirroring `aiFetch`.
- **`src/service/resolverService.ts`**: store the solver in `ResolverServiceDeps`
  and pass it into each `ResolutionAgent` in `runChain`, alongside a shared
  per‑job counter — mirror the existing `aiCallsUsed` / `aiMaxCalls` pair so the
  budget is shared across chained hops.
- **`src/agent/agent.ts`** (`AgentOptions`): add `solver: CaptchaSolver`,
  `captchaSolvesUsed`, and `captchaMaxSolves` fields.

---

## 7. Step 5 — The core hook in `loop()`

Modify the `if (challenge.blocking)` branch in `src/agent/agent.ts`. Try the
solver first; keep `this.fail('HUMAN_VERIFICATION_REQUIRED', …)` as the fallback.

```ts
const challenge = assessChallenge(snap);
if (challenge.blocking) {
  if (challenge.interstitial && this.challengeWaitUsed < this.cfg.challengeAutoWaitMs) {
    await this.waitForInterstitial(snap);
    continue;
  }

  const task = toCaptchaTask(snap);  // build from snap.challenge: kind, sitekey, pageUrl, action, invisible
  if (
    this.solver.enabled &&
    task &&
    this.captchaSolvesUsed < this.captchaMaxSolves
  ) {
    this.captchaSolvesUsed += 1;
    this.record('captcha-solve-attempt', `${task.kind} ${challenge.reason}`);
    const solution = await this.solver.solve(task, this.signal);
    if (solution) {
      const injected = await this.injectCaptchaToken(snap, task, solution.token);
      if (injected) {
        this.record('captcha-solved', task.kind);
        continue;   // re-observe; the flow should now advance
      }
    }
  }

  this.record('human-verification', challenge.reason);
  this.fail('HUMAN_VERIFICATION_REQUIRED', `Human verification is required: ${challenge.reason}`, {
    verification_url: snap.url,
    challenge_type: challenge.type,
  });
}
```

### Injecting the token

Use the page's existing `page`/frame handle (the same one `click()`/`navigate()`
use) and `evaluate()` to apply the token, then let the loop re‑observe:

```ts
private async injectCaptchaToken(snap, task, token): Promise<boolean> {
  const frame = /* the frame that holds the challenge (main frame or same-flow iframe) */;
  return frame.evaluate(({ token }) => {
    // 1. Fill the standard response field so a subsequent form submit carries it:
    for (const name of ['g-recaptcha-response', 'h-captcha-response', 'cf-turnstile-response']) {
      document.querySelectorAll<HTMLTextAreaElement>(`textarea[name="${name}"]`).forEach((el) => {
        el.value = token;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
    // 2. For invisible widgets, invoke the site callback if one is registered.
    //    (You will typically capture the callback name in the render hook.)
    return true;
  }, { token });
}
```

After injection you usually still need to **advance the flow**: either the site's
success callback auto‑submits, or the agent's normal candidate scoring clicks the
now‑enabled "Continue"/"Get Link" button on the next observe pass. Because the
loop `continue`s, that happens automatically on the next step — no special case
needed. Note that `scoring.ts` deliberately penalises human‑attestation controls
(`isHumanAttestation`, weight `-40`); that still applies, which is fine — after a
solve you want the *flow* button, not the checkbox.

---

## 8. Testing

Follow the existing test layout (`test/unit`, `test/integration`, mocks in
`test/helpers/`). Because all provider I/O goes through an injectable `fetch` and
the agent accepts injected modules, you can test end‑to‑end without a real
provider:

- **Unit** (`test/unit/captchaSolver.test.ts`): feed `HttpCaptchaSolver` a fake
  `fetch` and assert task creation, polling, timeout handling, and that failures
  return `null`.
- **Unit** (probe): extend `test/unit/classifier.test.ts` / a probe test to
  assert the sitekey/action are captured into `ChallengeSignals`.
- **Integration** (`test/integration/`): add a mock shortener page in
  `test/helpers/mockSites.ts` that renders a widget, inject a stub solver via
  `AppOverrides.captchaFetch`, and assert the resolution succeeds instead of
  returning `HUMAN_VERIFICATION_REQUIRED`. Keep a second test with the solver
  **disabled** asserting the original `HUMAN_VERIFICATION_REQUIRED` behaviour is
  unchanged.

---

## 9. Observability & operations

- **Metrics** (`src/metrics.ts`): add counters such as
  `captcha_solve_attempts_total`, `captcha_solve_success_total`,
  `captcha_solve_failed_total`, and a solve‑latency histogram, labelled by
  provider and CAPTCHA kind. Watch success rate and cost per solve.
- **Logging**: the solver already logs via a child logger. Never log the API key
  or the full token; respect the `LOG_URLS` setting for page URLs.
- **Budgets & cost**: `CAPTCHA_MAX_SOLVES_PER_JOB` and `JOB_TIMEOUT_MS` bound a
  single request; add external rate/spend limits at the provider if cost matters.

---

## 10. Checklist

- [ ] `captcha` config section added and validated in `src/config.ts`
- [ ] `.env.example` and `docs/CONFIGURATION.md` updated
- [ ] `src/agent/captchaSolver.ts` added (interface, `disabledSolver`, provider client, factory)
- [ ] Sitekey/action captured into `ChallengeSignals` (probe + render hook)
- [ ] Solver + per‑job budget threaded through `app.ts` → `resolverService.ts` → `AgentOptions`
- [ ] `loop()` attempts a solve before `HUMAN_VERIFICATION_REQUIRED`, with the original failure preserved as fallback
- [ ] Token injection + flow advancement verified
- [ ] Unit and integration tests, including a "disabled = unchanged behaviour" test
- [ ] Metrics and logging in place
- [ ] Ships **disabled by default**; enabled only where authorised

---

## 11. Related files

| Concern | File |
| --- | --- |
| Challenge gate (the hook point) | `src/agent/agent.ts` (`loop()`) |
| Challenge classification | `src/agent/classifier.ts` (`assessChallenge`) |
| In‑page detection / sitekey capture | `src/agent/pageProbe.ts` |
| Render‑time widget hook | `src/browser/initScripts.ts` (`captchaRenderHook`) |
| Shared types incl. `ChallengeSignals` | `src/agent/types.ts` |
| Pattern to copy (optional injected service) | `src/agent/aiAdvisor.ts` |
| Config system | `src/config.ts`, `.env.example`, `docs/CONFIGURATION.md` |
| Composition root / DI | `src/app.ts` |
| Request lifecycle / chaining | `src/service/resolverService.ts` |
