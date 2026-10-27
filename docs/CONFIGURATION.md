# Configuration

Configuration comes entirely from environment variables. At start-up the service also loads a `.env` file (path overridable with `ENV_FILE`); variables already set in the environment win. Invalid values stop the start-up with a list of all problems found.

## Server

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Listen address |
| `PORT` | `8080` | Listen port |
| `TRUST_PROXY_HOPS` | `0` | Trusted reverse proxies in front of the service. With `N > 0`, the client IP is the N-th entry from the right of `X-Forwarded-For`. Keep `0` if clients connect directly, otherwise they can spoof their IP. |
| `CORS_ORIGINS` | *(empty)* | Comma-separated allowed origins, or `*`. Empty disables CORS. |
| `MAX_BODY_BYTES` | `16384` | Maximum request body size |
| `HTTP_HEADERS_TIMEOUT_MS` | `15000` | Time allowed to receive request headers |
| `HTTP_REQUEST_TIMEOUT_MS` | `30000` | Time allowed to receive the full request (the response may take longer) |
| `SHUTDOWN_GRACE_MS` | `30000` | On SIGTERM/SIGINT: how long running jobs may finish. Queued jobs get `503 SHUTTING_DOWN`. |
| `CANCEL_ON_CLIENT_DISCONNECT` | `true` | Abort the browser job when a synchronous client disconnects (unless other clients are waiting for the same URL) |
| `NODE_ENV` | `production` | Informational |

## Authentication and rate limiting

| Variable | Default | Description |
| --- | --- | --- |
| `API_KEY_HASHES` | | `label:sha256hex,…`. Preferred, because no plaintext secrets sit in the environment. Generate with `npm run keygen`. |
| `API_KEYS` | | `label:key,…` (or bare keys). Minimum 16 characters. |
| `AUTH_DISABLED` | `false` | Turns authentication off. **Local development only.** The service refuses to start with no keys unless this is set. |
| `RATE_LIMIT_PER_MINUTE` | `30` | Resolve requests per minute per key (the read-endpoint bucket is 10×) |
| `RATE_LIMIT_BURST` | `10` | Bucket size |
| `AUTH_FAILURES_PER_MINUTE` | `10` | Failed authentications per IP before lockout |

## Logging and metrics

| Variable | Default | Description |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` \| `silent`. Logs are JSON lines on stdout. `debug` logs every agent step. |
| `LOG_URLS` | `host` | How submitted and destination URLs appear in logs: `full`, `host` (host only) or `none` |
| `METRICS_ENABLED` | `true` | Expose `/metrics` |
| `METRICS_REQUIRE_AUTH` | `true` | Require an API key for `/metrics` |

## Capacity and queue

| Variable | Default | Description |
| --- | --- | --- |
| `MAX_CONCURRENT_JOBS` | `4` | Jobs running in parallel (one browser context each, roughly 50–150 MB RAM and noticeable CPU). Start at about 1–2 per CPU core. |
| `MAX_QUEUE_SIZE` | `100` | Jobs allowed to wait. Beyond this, requests get `503 QUEUE_FULL`. |
| `QUEUE_TIMEOUT_MS` | `60000` | Maximum time in the queue (`503 QUEUE_TIMEOUT`) |
| `ASYNC_JOB_TTL_MS` | `900000` | How long async job results stay retrievable |
| `MAX_ASYNC_JOBS` | `10000` | Maximum pending async jobs |
| `RESULT_CACHE_TTL_MS` | `600000` | Cache successful resolutions for this long (`0` disables the cache) |
| `RESULT_CACHE_MAX_ENTRIES` | `5000` | Cache size (LRU) |

## Agent

| Variable | Default | Description |
| --- | --- | --- |
| `JOB_TIMEOUT_MS` | `150000` | Hard deadline per resolution, chained links included |
| `NAVIGATION_TIMEOUT_MS` | `30000` | Page load timeout (must not exceed `JOB_TIMEOUT_MS`) |
| `ACTION_TIMEOUT_MS` | `5000` | Click and other action timeout |
| `MAX_STEPS` | `30` | Observe→act iterations per link before `MAX_STEPS_EXCEEDED` |
| `MAX_COUNTDOWN_WAIT_MS` | `90000` | Total time a job may spend waiting (countdowns, disabled buttons, loading). A single countdown that needs more fails immediately with `COUNTDOWN_TOO_LONG`. |
| `CHALLENGE_AUTO_WAIT_MS` | `8000` | Cloudflare-style interstitials sometimes clear on their own. The agent waits this long **without interacting**, then reports `HUMAN_VERIFICATION_REQUIRED`. `0` disables the wait. |
| `MAX_CHAIN_DEPTH` | `2` | How many further supported short links to follow when a destination is itself a short link |
| `SETTLE_MS` | `2500` | How long to watch for navigation after a click |
| `MAX_REQUESTS_PER_JOB` | `3000` | Network requests allowed per job (enforced by the egress proxy) |
| `MAX_BYTES_PER_JOB` | `104857600` | Network bytes allowed per job |
| `RETRY_ON_BROWSER_CRASH` | `true` | Retry a job once on a fresh browser if the browser crashed |

## Browser

| Variable | Default | Description |
| --- | --- | --- |
| `BROWSER_HEADLESS` | `true` | Headless mode. Headed mode needs the full Chromium build and a display. |
| `BROWSER_EXECUTABLE_PATH` | | Use a specific Chromium binary instead of Playwright's |
| `BROWSER_SANDBOX` | `false` | Enable Chromium's OS sandbox. Recommended when the host allows it (non-root user with user namespaces). In containers this usually needs a custom seccomp profile. |
| `BROWSER_RECYCLE_AFTER_JOBS` | `100` | Replace the browser process after this many jobs, to bound memory |
| `BROWSER_LAUNCH_TIMEOUT_MS` | `30000` | Browser start timeout |
| `USER_AGENT` | *(Chromium default)* | Override the User-Agent |
| `BLOCK_RESOURCE_TYPES` | `media,font` | Sub-resource types not loaded (`image`, `media`, `font`, `stylesheet`, …). Blocking images or stylesheets can trigger anti-adblock walls on some sites. |
| `BLOCK_AD_DOMAINS` | `false` | Block well-known ad networks. Faster, but many shorteners show anti-adblock walls when this is on. |
| `BROWSER_EXTRA_ARGS` | | Extra Chromium flags (comma-separated) |
| `PLAYWRIGHT_BROWSERS_PATH` | *(Playwright default)* | Where Playwright browsers are installed |

## Network policy (SSRF protection)

| Variable | Default | Description |
| --- | --- | --- |
| `ALLOWED_PORTS` | `80,443` | Destination ports the browser and server may connect to (`any` allows all) |
| `ALLOW_PRIVATE_NETWORK_CIDRS` | *(empty)* | **Dangerous.** CIDRs exempt from the private/reserved-address block (for example `127.0.0.1/32` in tests). Leave empty in production. |
| `DOMAIN_DENYLIST` | | Domains (and their subdomains) that may never be contacted |
| `DESTINATION_DENYLIST` | | Destination domains the API refuses to return (`403 DESTINATION_NOT_ALLOWED`) |
| `DNS_CACHE_TTL_MS` | `30000` | Cache time for validated DNS answers |

## Shorteners

| Variable | Default | Description |
| --- | --- | --- |
| `ADLINKFLY_EXTRA_DOMAINS` | | More AdLinkFly-based shortener domains, handled by the generic AdLinkFly module (`adlinkfly`) |
| `ALLOW_UNLISTED_SHORTENERS` | `false` | Let the generic agent attempt any host. Increases abuse potential; prefer explicit domains. |
| `DISABLED_SHORTENER_MODULES` | | Module ids to disable (`arolinks`, `adlinkfly`, `generic`) |

## Destination extraction

| Variable | Default | Description |
| --- | --- | --- |
| `FOLLOW_TRACKING_REDIRECTS` | `true` | Resolve known URL redirectors (t.co, bit.ly, …) with SSRF-safe HEAD requests. The final destination itself is never requested. |
| `MAX_REDIRECT_HOPS` | `5` | Maximum redirector hops |
| `STRIP_TRACKING_PARAMS` | `true` | Remove `utm_*`, `fbclid`, `gclid`, `msclkid` and similar parameters |

## AI fallback (optional)

Off by default. When enabled, the model is consulted only when the heuristics find no clear action, or when a new page might be either the destination or another flow step. Calls per job are capped.

| Variable | Default | Description |
| --- | --- | --- |
| `AI_PROVIDER` | `none` | `openai` (any OpenAI-compatible Chat Completions API: OpenAI, Azure-compatible gateways, OpenRouter, vLLM, Ollama, …) or `anthropic` |
| `AI_MODEL` | | Model name (required when enabled) |
| `AI_API_KEY` | | Required unless `AI_BASE_URL` points to localhost |
| `AI_BASE_URL` | `https://api.openai.com/v1` / `https://api.anthropic.com` | Endpoint base URL |
| `AI_TIMEOUT_MS` | `20000` | Per-call timeout |
| `AI_MAX_CALLS_PER_JOB` | `4` | Cap per resolution |
| `AI_JSON_MODE` | `true` | Send `response_format: json_object` (turn off for servers that reject it) |

The model receives the page URL, title, a text excerpt of up to 1,500 characters, and a list of interactive elements. Page content goes to the provider you configure.
