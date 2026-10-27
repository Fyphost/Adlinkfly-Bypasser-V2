# Deployment and operations

## Requirements

- Node.js ≥ 22.18 (or the provided Docker image)
- About 1 GB RAM plus 100–150 MB per concurrent job, and 1 CPU per 1–2 concurrent jobs
- Outbound HTTP/HTTPS to the shortener and its partner sites (directly or through your network egress)

## Docker (recommended)

```bash
npm run keygen                  # put the digest into .env as API_KEY_HASHES=prod:<digest>
cp .env.example .env
docker compose up -d --build
curl -s localhost:8080/ready
```

What the image provides:

- It installs the headless Chromium build that matches the installed Playwright version, plus its OS libraries.
- It runs as an unprivileged user under `tini`, which reaps Chromium's child processes.
- It includes a `HEALTHCHECK`.

`docker-compose.yml` adds a read-only root filesystem with a `/tmp` tmpfs, `no-new-privileges`, dropped capabilities, `shm_size` and resource limits.

Without compose:

```bash
docker build -t adlinkfly-resolver .
docker run -d --name resolver -p 8080:8080 --env-file .env --shm-size=1g \
  --read-only --tmpfs /tmp:size=512m --security-opt no-new-privileges --cap-drop ALL adlinkfly-resolver
```

If no `package-lock.json` is committed, the image build runs `npm install`. Commit the lock file that your first `npm install` generates so builds are reproducible.

## Bare metal / VM (systemd)

```bash
npm install && npm run build
# Install browsers into a fixed location (independent of the service user's $HOME):
sudo PLAYWRIGHT_BROWSERS_PATH=/opt/adlinkfly-resolver/browsers npx playwright install --with-deps chromium
```

```ini
# /etc/systemd/system/adlinkfly-resolver.service
[Service]
WorkingDirectory=/opt/adlinkfly-resolver
EnvironmentFile=/opt/adlinkfly-resolver/.env
# Chromium writes caches under $HOME; keep them in the private /tmp.
Environment=HOME=/tmp
Environment=PLAYWRIGHT_BROWSERS_PATH=/opt/adlinkfly-resolver/browsers
ExecStart=/usr/bin/node dist/index.js
User=resolver
Restart=on-failure
KillSignal=SIGTERM
TimeoutStopSec=60
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/tmp

[Install]
WantedBy=multi-user.target
```

To use Chromium's OS sandbox (`BROWSER_SANDBOX=true`), run as a non-root user on a kernel with unprivileged user namespaces enabled.

## Reverse proxy

Synchronous resolutions can take up to `JOB_TIMEOUT_MS`, which is 150 s by default. Make the proxy's read timeout at least that long, or have clients use `"async": true`.

```nginx
location / {
  proxy_pass http://127.0.0.1:8080;
  proxy_read_timeout 180s;
  proxy_send_timeout 30s;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Request-Id $request_id;
}
```

Set `TRUST_PROXY_HOPS=1` so rate limiting and logs see the real client IP. Terminate TLS at the proxy and add HSTS there.

## Scaling

- **Vertical.** Raise `MAX_CONCURRENT_JOBS` while watching CPU and memory (`resolver_browser_contexts_active`, container memory). `MAX_QUEUE_SIZE` and `QUEUE_TIMEOUT_MS` determine when the service starts shedding load with `503` and `Retry-After`.
- **Horizontal.** Instances are stateless except for three per-instance pieces:
  - the result cache;
  - the in-flight de-duplication;
  - async jobs.

  Route `/api/jobs/*` with sticky sessions (for example, a hash on the job id), or keep clients on synchronous calls. Rate limits are per instance, so divide the limits by the instance count, or enforce global limits at the gateway.
- **Readiness.** `/ready` returns `503` while the browser is down, the queue is saturated, or the instance is shutting down. Use it for load-balancer health checks.
- **Shutdown.** On `SIGTERM` the server stops accepting connections, rejects queued jobs with `503 SHUTTING_DOWN`, lets running jobs finish for up to `SHUTDOWN_GRACE_MS`, and then closes the browser. Give the orchestrator at least `SHUTDOWN_GRACE_MS + 20s`.

## Monitoring

Scrape `GET /metrics` (it needs an API key unless `METRICS_REQUIRE_AUTH=false`). The useful series are:

| Metric | Watch for |
| --- | --- |
| `resolver_resolutions_total{shortener,outcome}` | Rising `HUMAN_VERIFICATION_REQUIRED`, `NO_ACTION_FOUND` or `MAX_STEPS_EXCEEDED`: a site probably changed its pages |
| `resolver_resolution_duration_seconds` | Latency, mostly driven by site countdowns |
| `resolver_queue_waiting_jobs`, `resolver_queue_active_jobs` | Saturation: add capacity |
| `resolver_browser_crashes_total` | Memory pressure: lower concurrency or `BROWSER_RECYCLE_AFTER_JOBS` |
| `resolver_egress_blocked_total` | Attempted access to private addresses, worth investigating |
| `resolver_http_requests_total{route,status}` | 401/429 spikes (abuse) and 5xx |

Logs are JSON lines. Every line about a request carries `request_id`, and the same id appears in the response body and the `X-Request-Id` header.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Start-up fails with `Invalid configuration` | The error lists every problem. A common one: no API keys (set `API_KEY_HASHES` or `API_KEYS`). |
| `BROWSER_ERROR: The browser engine could not be started` | Chromium or its libraries are missing. Run `npx playwright install --with-deps chromium`. Its version must match the installed `playwright` package. In containers, use the provided image. |
| Chromium crashes under load | Raise memory or `shm_size`, lower `MAX_CONCURRENT_JOBS`, lower `BROWSER_RECYCLE_AFTER_JOBS`. |
| Every link fails with `NAVIGATION_FAILED … could not be resolved` | The host has no DNS or outbound access. Check egress firewall and proxy settings. |
| `HUMAN_VERIFICATION_REQUIRED` | The site requires a CAPTCHA or challenge (sometimes only for datacenter IPs). That is intended behaviour: a person must open `verification_url`. |
| `ADBLOCK_WALL` | Set `BLOCK_AD_DOMAINS=false` and keep images and stylesheets unblocked (`BLOCK_RESOURCE_TYPES=media,font`). |
| `NO_ACTION_FOUND` / `MAX_STEPS_EXCEEDED` on a supported site | The site's layout changed. Re-run with `"include_trace": true` and `LOG_LEVEL=debug` to see each step's candidates and scores. Then add hints to the module (patterns, preferred selectors) or enable the AI fallback. |
| `COUNTDOWN_TOO_LONG` | The site's timer exceeds `MAX_COUNTDOWN_WAIT_MS`. Raise it, together with `JOB_TIMEOUT_MS`. |
| `TIMEOUT` | The whole flow took longer than `JOB_TIMEOUT_MS`. Multi-page flows with several countdowns may need 150–300 s. |
| `NAVIGATION_BLOCKED` | The site redirected to a private or internal address or a disallowed port. This is the SSRF protection working; check `error` for the host. |
| Clients time out but the server logs success | The reverse proxy or client timeout is shorter than the resolution time. Raise it, or use async jobs. |
| `503 QUEUE_FULL` | Over capacity. Clients should honour `Retry-After`; otherwise scale up. |
