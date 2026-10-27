# API reference

Base URL: `http://<host>:<port>`. All bodies are JSON (`Content-Type: application/json`). Every response has an `X-Request-Id` header. The server echoes your `X-Request-Id` if it matches `[A-Za-z0-9._:-]{1,64}` and generates one otherwise.

## Authentication

Endpoints under `/api/*` (and `/metrics` by default) need an API key:

```
Authorization: Bearer <key>
# or
X-API-Key: <key>
```

A missing or invalid key returns `401 UNAUTHORIZED`. After `AUTH_FAILURES_PER_MINUTE` failed attempts from one IP, that IP gets `429` with `Retry-After`.

## Rate limiting

Each API key has a token bucket (`RATE_LIMIT_PER_MINUTE`, `RATE_LIMIT_BURST`). Responses from rate-limited endpoints carry `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers. Once the bucket is empty you get `429 RATE_LIMITED` with `Retry-After`. Read endpoints (`/api/jobs`, `/api/shorteners`, `/metrics`) use a separate bucket that is 10× larger.

---

## `POST /api/resolve`

Resolves a short link.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | yes | Short link (`http(s)://…`; a missing scheme defaults to `https://`). Max 2048 chars. |
| `async` | boolean | no | Return `202` with a job id immediately instead of waiting (see `GET /api/jobs/:id`). |
| `include_trace` | boolean | no | Include the agent's step-by-step trace (bypasses cache and de-duplication). |
| `no_cache` | boolean | no | Skip the result cache. |

Synchronous resolution can take as long as `JOB_TIMEOUT_MS` (150 s by default), because countdown pages are waited out. Set client and reverse-proxy timeouts to match, or use `async`.

### Success — `200`

```json
{
  "success": true,
  "status": "resolved",
  "original_url": "https://arolinks.com/example",
  "destination_url": "https://example.com/file",
  "message": "Destination URL resolved successfully",
  "shortener": "arolinks",
  "steps": 8,
  "duration_ms": 14210,
  "cached": false,
  "chain": ["https://other-shortener.example/x"],
  "trace": [{ "step": 2, "url": "…", "title": "…", "action": "click", "detail": "best candidate \"Verify\" […]", "at": 3120 }],
  "request_id": "…"
}
```

`chain` appears only when the link pointed to another supported short link that was followed as well. `trace` appears only when `include_trace` is set.

### Error

Every error, whatever its HTTP status, uses the same shape:

```json
{
  "success": false,
  "status": "failed",
  "original_url": "https://arolinks.com/example",
  "destination_url": null,
  "message": "Unable to resolve the destination URL",
  "error": "Maximum navigation attempts exceeded (30 steps)",
  "error_code": "MAX_STEPS_EXCEEDED",
  "steps": 31,
  "last_url": "https://blog.example/step",
  "request_id": "…"
}
```

`message` is a short summary for the error category, `error` describes this specific failure, and `error_code` is stable and meant for programs. Some errors add fields: `verification_url` and `challenge_type` for human verification, `retry_after` for capacity errors, `page_messages` (alerts or platform messages shown by the site), and `supported` for unsupported shorteners.

### Error codes

| HTTP | `error_code` | `status` | Meaning |
| --- | --- | --- | --- |
| 400 | `INVALID_REQUEST` | invalid_request | Malformed JSON, missing `url`, wrong field types |
| 400 | `INVALID_URL` | invalid_request | Not an http(s) URL, embedded credentials, whitespace, too long |
| 401 | `UNAUTHORIZED` | unauthorized | Missing / invalid API key |
| 403 | `URL_NOT_ALLOWED` | forbidden | URL targets a private/internal address, a disallowed port or a deny-listed domain |
| 403 | `NAVIGATION_BLOCKED` | forbidden | The shortener tried to redirect the browser to a forbidden address |
| 403 | `DESTINATION_NOT_ALLOWED` | forbidden | Destination host is in `DESTINATION_DENYLIST` |
| 404 | `LINK_NOT_FOUND` | link_unavailable | The short link does not exist |
| 410 | `LINK_EXPIRED` | link_unavailable | Expired, deleted, disabled or banned link |
| 413 | `PAYLOAD_TOO_LARGE` | invalid_request | Body larger than `MAX_BODY_BYTES` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | invalid_request | Body is not JSON |
| 422 | `UNSUPPORTED_SHORTENER` | unsupported | Host not handled by any module |
| 422 | `HUMAN_VERIFICATION_REQUIRED` | human_verification_required | CAPTCHA, Cloudflare challenge or "I'm not a robot" step: a person has to open `verification_url` |
| 422 | `ADBLOCK_WALL` | failed | The site refuses to continue because ads were blocked |
| 429 | `RATE_LIMITED` | rate_limited | Rate limit or auth-failure lockout |
| 502 | `NAVIGATION_FAILED` | failed | A page could not be loaded (DNS, connection, TLS, HTTP 5xx/403) |
| 502 | `NO_ACTION_FOUND` | failed | No usable button/link and the page did not change |
| 502 | `MAX_STEPS_EXCEEDED` | failed | Maximum navigation attempts exceeded |
| 502 | `REDIRECT_LOOP` | failed | Redirect loop or the flow kept returning to the same page |
| 502 | `UNEXPECTED_PAGE` | failed | Page could not be analysed or the extracted destination is not an http(s) URL |
| 503 | `BROWSER_ERROR` | unavailable | Browser crashed or failed to start (crashed jobs are retried once automatically) |
| 503 | `QUEUE_FULL` / `QUEUE_TIMEOUT` | unavailable | Over capacity; honour `Retry-After` |
| 503 | `SHUTTING_DOWN` | unavailable | Instance is draining |
| 504 | `TIMEOUT` | timeout | `JOB_TIMEOUT_MS` exceeded |
| 504 | `NAVIGATION_TIMEOUT` | timeout | A page did not load within `NAVIGATION_TIMEOUT_MS` |
| 504 | `COUNTDOWN_TOO_LONG` | timeout | The page requires waiting longer than `MAX_COUNTDOWN_WAIT_MS` |
| 500 | `INTERNAL_ERROR` | failed | Unexpected error (details only in server logs) |

Retrying is reasonable for `429`, `503` and `504`, and for `502 NAVIGATION_FAILED` after a delay. The other errors usually come out the same on retry.

### Human verification example — `422`

```json
{
  "success": false,
  "status": "human_verification_required",
  "original_url": "https://arolinks.com/abc",
  "destination_url": null,
  "message": "Human verification is required; the link cannot be resolved automatically",
  "error": "Human verification is required: visible recaptcha challenge",
  "error_code": "HUMAN_VERIFICATION_REQUIRED",
  "verification_url": "https://arolinks.com/abc",
  "challenge_type": "recaptcha",
  "request_id": "…"
}
```

---

## Asynchronous jobs

`POST /api/resolve` with `"async": true` checks the URL straight away (invalid or unsupported URLs fail at once), then answers:

```http
HTTP/1.1 202 Accepted
Location: /api/jobs/2b0c…

{"success":true,"status":"queued","job_id":"2b0c…","status_url":"/api/jobs/2b0c…","original_url":"…","destination_url":null,"message":"Resolution job accepted","request_id":"…"}
```

### `GET /api/jobs/:id`

- While pending: `200` with `job_status` = `queued` | `running`.
- When finished: `200` with `job_status` = `completed` | `failed`, `http_status` (the status a synchronous call would have returned), plus the full success or error body shown above.
- Only the API key that created a job can read it; any other key gets `404`. Jobs expire after `ASYNC_JOB_TTL_MS`.

Jobs are kept in memory, so with several instances you need sticky routing for `/api/jobs/*`.

## `GET /api/shorteners`

Lists active modules: `{"success":true,"allow_unlisted":false,"shorteners":[{"id":"arolinks","name":"AroLinks","platform":"adlinkfly","domains":["arolinks.com"],"description":"…"}]}`.

## Operational endpoints

| Endpoint | Auth | Description |
| --- | --- | --- |
| `GET /health` | no | Liveness: `{"status":"ok","uptime_s":12}` |
| `GET /ready` | no | Readiness: `200` when the browser is up and the queue is not saturated, otherwise `503`; includes browser and queue stats |
| `GET /metrics` | yes (configurable) | Prometheus text format: resolutions by outcome, duration histogram, HTTP requests, queue depth, active contexts, browser launches/crashes, egress blocks |

## Examples

```bash
# Resolve (sync)
curl -s localhost:8080/api/resolve -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"url":"https://arolinks.com/example"}'

# Resolve with trace
curl -s localhost:8080/api/resolve -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"url":"https://arolinks.com/example","include_trace":true}' | jq '.trace[] | [.step,.action,.detail]'

# Async
JOB=$(curl -s localhost:8080/api/resolve -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"url":"https://arolinks.com/example","async":true}' | jq -r .job_id)
curl -s localhost:8080/api/jobs/$JOB -H "X-API-Key: $KEY"
```

```js
const res = await fetch('http://localhost:8080/api/resolve', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.API_KEY}` },
  body: JSON.stringify({ url: 'https://arolinks.com/example' }),
  signal: AbortSignal.timeout(180_000),
});
const body = await res.json();
if (body.success) console.log(body.destination_url);
else console.error(res.status, body.error_code, body.error);
```
