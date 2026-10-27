# AdLinkFly Resolver API

A REST API that resolves short links from AdLinkFly-based shorteners such as **arolinks.com** to their final destination URL. A Playwright browser agent visits the link and works through the intermediate pages (verify / continue / get-link buttons, countdowns, partner blog steps, redirects, pop-ups) the way a visitor would. It then returns the destination it verified as JSON.

```http
POST /api/resolve
Authorization: Bearer <api-key>
Content-Type: application/json

{"url": "https://arolinks.com/example"}
```

```json
{
  "success": true,
  "status": "resolved",
  "original_url": "https://arolinks.com/example",
  "destination_url": "https://example.com",
  "message": "Destination URL resolved successfully",
  "shortener": "arolinks",
  "steps": 8,
  "duration_ms": 14210,
  "cached": false,
  "request_id": "6f1c…"
}
```

## Highlights

- **Detection that doesn't depend on hardcoded selectors.** Every visible clickable element is scored on its label (a weighted, multilingual lexicon), attributes, link target, page context (ad containers, nav, footer), geometry, and how many times it has already been tried. AdLinkFly page structures are recognised directly. An optional LLM advisor handles pages the heuristics can't decide.
- **Multi-step navigation.** The agent handles countdowns (it waits for them to finish; it never changes timers), disabled buttons, content that appears on scroll, meta-refresh and JS redirects, same-site iframes, pop-ups and tab-unders, downloads, and chained short links. Cookies and session state persist for the whole job.
- **Destination extraction.** The destination comes from the platform's own API response or released link, or from the landing page. Redirect wrappers (`google.com/url`, `l.facebook.com`, …) and known URL redirectors are removed, and tracking parameters are stripped.
- **Respects human verification.** CAPTCHAs (reCAPTCHA, hCaptcha, Turnstile, Arkose, GeeTest, text CAPTCHAs), Cloudflare challenges and "I'm not a robot" prompts are detected and reported as `human_verification_required`. They are never bypassed.
- **Security.** All browser traffic goes through a built-in egress proxy that resolves DNS itself and connects only to validated public addresses. This blocks SSRF and DNS rebinding, including through redirects and sub-resources. The service also enforces API-key auth (keys can be stored as SHA-256 digests), per-key rate limits, auth-failure lockout, request logging with URL redaction, and hardened browser contexts.
- **Operations.** A bounded job queue with load shedding, per-job timeouts and cancellation, request de-duplication, a result cache, async jobs, browser crash recovery and recycling, graceful shutdown, `/health`, `/ready` and Prometheus `/metrics`.

## Quick start

Requires **Node.js ≥ 22.18**.

```bash
npm install
npx playwright install --with-deps chromium   # browser + OS libraries
npm run keygen                                 # prints an API key and its SHA-256 digest
cp .env.example .env                           # put the digest into API_KEY_HASHES=label:<digest>
npm run build && npm start                     # or: npm run dev (runs the TypeScript directly)
```

```bash
curl -s http://localhost:8080/api/resolve \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://arolinks.com/example"}'
```

To run with Docker: `docker compose up --build` (reads `.env`). See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Documentation

| Document | Contents |
| --- | --- |
| [docs/API.md](docs/API.md) | Endpoints, request/response schemas, every error code, examples |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | All environment variables |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, agent decision loop, security model, adding shortener modules |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Docker, reverse proxy, scaling, monitoring, troubleshooting |

## Tech stack

TypeScript on Node.js 22 with **Playwright/Chromium**, which is the only runtime dependency. The HTTP server, router, rate limiter, queue, egress proxy and metrics are built on Node built-ins, which keeps the attack surface and supply-chain footprint small. Tests use the built-in `node:test` runner.

## Testing

```bash
npm run typecheck
npm test              # unit + integration (needs Chromium: npx playwright install chromium)
```

The integration tests run the whole stack (HTTP API → queue → Chromium → egress proxy → agent) against a local, high-fidelity simulation of AdLinkFly sites. The simulation covers:

- Supported flows: classic countdown + `/links/go`, a multi-step arolinks-style flow across two partner blogs, different layouts and languages, pop-ups and tab-unders, iframes, downloads, tracking wrappers, chained links.
- Human-verification pages and error conditions: expired or missing links, adblock walls, missing buttons, SSRF redirects, loops, step and countdown limits, timeouts, browser crashes.
- API behaviour, concurrency, and the AI fallback (against a mock model server).

The simulated server enforces the same constraints as real deployments: a CSRF cookie and token, a server-side countdown, flow cookies, and Referer checks.

## Scope and responsible use

The agent only does what a visitor's browser would do: it loads pages, waits out the countdowns those pages show, and clicks the buttons they offer. It does not solve or evade CAPTCHAs, change timers, forge platform requests, or use anti-detection ("stealth") techniques. When a site requires human verification, the API says so and does not report a false success. Use it in line with the terms of the sites you resolve links for.

Shortener operators change their pages often. Detection is heuristic and module-based, so a supported site can still change in ways that need a module update; see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#adding-a-shortener-module).
