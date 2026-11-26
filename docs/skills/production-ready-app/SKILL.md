---
name: production-ready-app
description: Audit, attack-test and harden a backend, web app or mobile app so it is secure, scales to 1,000+ users and stays up without errors - security, self-pentest, scale, infrastructure, operations, SEO, accessible UI and failure paths. Use for any backend work or when making an app production-ready.
---

# Production-ready app: secure, scalable, robust

Use when the user asks to make an app/backend production-ready, secure it, test it by attacking it, make it survive real users, keep it up without errors, harden a vibe-coded project, or apply this skill to their projects.

Sources: TikTok checklists (backend concepts vibe coders miss; 11 things so your app doesn't crash at 1,000 users; 14 things so your site shows up on Google; don't hand-roll UI with AI; works on my machine but fails in prod), extended with standard OWASP and SRE practice.

## How to run it

1. **Map the project.** Detect the stack (package.json, requirements.txt, pyproject, go.mod, pom.xml/build.gradle, pubspec.yaml, Supabase/Firebase config, Dockerfile, k8s manifests, render.yaml). Find entry points, routes, auth, DB layer, env/config, background jobs, and the frontends that call it. Read CLAUDE.md and PRODUCTION_AUDIT.md if present. Mark which sections apply.
2. **Audit the code** against sections A-H, citing `file:line`. Rate each item: done / partial / missing / N/A.
3. **Attack-test it (section B)** against a local or staging copy you own. Every finding from step 2 gets a reproduction; every fix gets re-tested.
4. **Write/update `PRODUCTION_AUDIT.md`**: summary, findings by severity (Critical > High > Medium > Low) with evidence, reproduction and fix, plus a "Verified by attack test" column.
5. **Fix in small commits** on `hardening/production-ready`. Critical security first. Ask before anything that changes behaviour for existing clients: adding auth to a route a frontend relies on, schema-destroying migrations, dependency major bumps, secret rotation, infra/billing changes.
6. **Verify**: build, lint, tests, re-run the attack tests, hit `/healthz`. Record what was fixed and what is left in the project's CLAUDE.md under "Production hardening — continue here".

## A. Security (code review)

**Injection & input**
- SQL injection: parameterized queries/ORM only, never string-built SQL.
- NoSQL injection: strip `$`/`.` operators (mongo-sanitize), cast ids, never pass `req.body` straight into a query.
- Command injection: no `exec`/`spawn` with user input in a shell; argument arrays only.
- Path traversal: resolve and check paths stay inside the allowed directory.
- SSRF: user-supplied URLs fetched server-side go through an allow-list; block private/metadata IPs (127.0.0.1, 10/8, 169.254.169.254).
- Validation: schema validation (zod/joi/pydantic) at every boundary; max lengths; body, upload and JSON size limits; mass-assignment protection (never take `role`, `isAdmin`, `balance` from the body).

**Output & browser**
- XSS: output encoding; no `innerHTML`/`dangerouslySetInnerHTML`/`v-html` with user data; sanitize rich text (DOMPurify).
- Security headers: Content-Security-Policy, HSTS, `X-Content-Type-Options: nosniff`, `frame-ancestors`, Referrer-Policy. Headers and the rate limiter are registered **before every router**.
- CORS: explicit allowed origins; never `*` with credentials.
- CSRF: tokens or SameSite cookies for cookie-based auth.
- Open redirects: redirect targets checked against an allow-list.
- Clickjacking: `frame-ancestors 'none'` on sensitive pages.

**Auth & access**
- Passwords: bcrypt/argon2, minimum length; generic "invalid email or password" messages (no user enumeration).
- Brute force: per-IP and per-account rate limits plus lockout/backoff on login, OTP, password reset and signup.
- JWT: short-lived access tokens (5-15 min), rotating refresh tokens stored hashed with reuse detection, verify signature + `exp`, pin `alg` (reject `none`), secret >= 32 random bytes, revoke on logout/password change. Tokens never in query strings or logs.
- Sessions/cookies: `HttpOnly`, `Secure`, `SameSite`.
- Authorization: every route checks who the user is AND that they may touch this record (IDOR). Admin routes check the role server-side from the DB. Supabase: RLS on every table.
- OAuth: `state` checked, redirect_uri allow-listed, PKCE for public clients.

**Data & secrets**
- Secrets only in env/secret manager; `.env` in `.gitignore`; scan git history (gitleaks/trufflehog); server-only keys never in client bundles; rotate any key that ever leaked.
- Sensitive fields (password, tokens, reset codes) stripped from every API response, including populated relations.
- HTTPS everywhere; encrypted backups; least-privilege DB user.
- File uploads: check type by content (magic bytes), cap size, use random names, store in object storage or outside the web root, serve with the correct type; never serve user SVG/HTML inline.
- Payments/webhooks: verify signatures on the raw body; idempotency keys; amounts computed server-side, never trusted from the client.

**Supply chain**
- `npm audit` / `pip-audit` / `govulncheck`; remove unused and typosquat-prone packages (`crypto`, `fs`, `https`, `stream` on npm are not the built-ins); commit the lockfile; turn on Dependabot/Renovate.

## B. Attack-test your own app (self-pentest)

Only test systems you own, on local or staging, never real users' data or live payments. Write each test as a script or test case so it can be re-run after fixes.

1. **Recon**: list every route (Swagger/OpenAPI, router dump), every frontend-exposed key, every public file (`/.env`, `/.git/config`, backups, source maps).
2. **Injection**: send NoSQL operators (`{"email":{"$ne":null},"password":{"$ne":null}}`), SQL quote breaks (`' OR '1'='1`) and shell metacharacters to every input; expect 400, never data.
3. **XSS**: submit `<img src=x onerror=alert(1)>` into every text field that is shown back (names, comments, captions, messages); confirm it renders as text.
4. **Broken access control / IDOR**: log in as user A, take a record id belonging to user B, try GET/PATCH/DELETE on it; try admin routes as a normal user; try every route with no token. Expect 401/403/404.
5. **Auth attacks**: 50 wrong passwords in a minute must hit the limiter; a forged JWT (edited payload, `alg: none`, expired, signed with a guessable secret) must be rejected; reset tokens are single-use and expire; signup with `"role":"admin"` must not grant admin.
6. **Rate limit & DoS**: burst 500 requests at login, AI and upload endpoints; send a 50 MB body and deeply nested JSON; expect 429/413 and the server stays up.
7. **Uploads**: upload a `.html`/`.svg` with script, a renamed `.exe`, an oversized file, a filename containing `../`; none should execute or escape.
8. **Redirects & CORS**: send `Origin: https://evil.example` with credentials; try `redirect_uri=https://evil.example` on OAuth and payment callbacks.
9. **Info leaks**: errors must not include stack traces, queries or env values; `X-Powered-By` is gone; grep the built frontend bundle for keys.
10. **Business logic**: negative quantities/prices, replaying a payment webhook, paying once and redeeming twice, racing two requests that spend the same balance.
11. **Scanners** (staging only): OWASP ZAP baseline scan, `nuclei` against the staging URL, `npm audit`, gitleaks on the repo. Triage results; don't report raw scanner output as findings.
12. **Re-test** every fix with the same script and mark it "verified" in the audit.

## C. Scale: survive 1,000+ concurrent users

1. **Real email provider** - Resend/Postmark/SES/Brevo, not dev SMTP or Gmail SMTP.
2. **Index what you search** - every field used in filters, joins, sorts and foreign keys; confirm with `EXPLAIN`/`.explain()`.
3. **Speed up RLS policies** - `(select auth.uid())`, index policy columns, no joins in policies.
4. **Connection pooler** - one shared pool per process with explicit size and fail-fast timeouts; PgBouncer/Supavisor for serverless.
5. **Kill N+1 queries** - eager-load/batch; never load a whole collection to find one record.
6. **Paginate every list** - cursor or limit/offset, max page size ~100.
7. **Cache what's the same** - CDN + HTTP cache headers for public data; Redis/in-memory for hot reads; invalidate on write.
8. **Retry AI/external calls with backoff** - exponential backoff + jitter, a timeout on every outbound call, circuit breaker, handle 429.
9. **Slow jobs in a queue** - email, media processing, AI generations, exports, webhooks -> BullMQ/Celery/Cloud Tasks with retries and a dead-letter queue.
10. **Check realtime limits** - provider connection/message limits; unsubscribe on unmount; don't broadcast whole tables.
11. **Load-test before launch** - k6/Artillery/Locust ramping to 1,000 virtual users on staging; watch p95 latency, error rate, DB CPU and connection count; fix the first bottleneck and repeat.

## D. Infrastructure & architecture

- **Stateless app servers** so you can run more than one: sessions, rate-limit counters and socket state in Redis; files in object storage, not on local disk.
- **Load balancing**: 2+ instances behind the platform load balancer; health checks remove bad instances; WebSockets need sticky sessions or a Redis adapter.
- **Reverse proxy** (Nginx/Caddy/Cloudflare/platform router): TLS termination, compression, request size limits, timeouts; set `trust proxy` to the real hop count so `req.ip` is correct.
- **API gateway** once there are several services or public API consumers: one entry point for auth, rate limits, API keys, routing and versioning (Kong, AWS API Gateway, Cloudflare, Traefik). For a monolith, a reverse proxy plus middleware is enough.
- **Message queues vs Pub/Sub**: a queue delivers each job to one worker (send this email, process this payment); pub/sub fans one event out to many subscribers (order.paid -> email + analytics + notification). Use BullMQ/Redis Streams, RabbitMQ, Google Pub/Sub or SNS/SQS; make every consumer idempotent.
- **WebSockets**: authenticate on connect (token verified server-side), heartbeat plus auto-reconnect with backoff, per-connection rate limits and message size caps, a Redis adapter when running multiple instances, close idle sockets.
- **TCP vs UDP**: HTTP and WebSockets run on TCP (ordered, reliable): right for APIs, chat and payments. UDP (WebRTC, QUIC/HTTP3, game state) suits live voice/video/game updates where late data is useless. Don't hand-build reliability on UDP; use WebRTC/QUIC.
- **Docker & Kubernetes**: containerize with a small, non-root image and a `HEALTHCHECK`. Move to Kubernetes only when you run many services or need autoscaling across nodes; then set liveness/readiness probes (`/healthz`, `/readyz`), resource requests/limits, a HorizontalPodAutoscaler, rolling updates, and secrets from k8s Secrets or an external secret manager. For one app on Render/Railway/Fly, use the platform's autoscaling instead.
- **Feature flags**: put risky features behind a flag (env var, Unleash, LaunchDarkly or a DB table) so they can be switched off without a deploy.
- **Database migrations**: versioned, forward-only and backward-compatible (expand -> migrate -> contract), run by CI/deploy; never edit an applied migration; back up before a big one.
- **Memory leaks**: no unbounded in-memory caches/maps/arrays; remove event listeners; close streams and cursors; cap queue sizes; watch memory over time and set a restart threshold (PM2 `max_memory_restart`).
- **DDoS**: Cloudflare/WAF in front, rate limits at the edge and in the app, cheap 4xx for bad requests, autoscaling caps so an attack can't run up the bill.

## E. Robustness: stay up without errors

- `GET /healthz` (liveness) and `GET /readyz` (DB and critical dependencies reachable), wired to the host's health check and an uptime monitor (UptimeRobot/Better Stack).
- Exit non-zero when a required dependency is unreachable at boot so the process manager restarts it; graceful SIGTERM shutdown (stop accepting, finish in-flight requests, close DB, hard stop after ~10s).
- One central error handler with consistent JSON errors; every async error reaches it; no stack traces sent to clients.
- Log `unhandledRejection`/`uncaughtException`; error tracking (Sentry); structured logs with request ids and no secrets, tokens or PII.
- A timeout on every outbound HTTP/DB call; retry only idempotent operations.
- Validate the environment at boot: fail fast if `JWT_SECRET`, `MONGO_URI` etc. are missing or weak.
- Backups: automated daily DB backups with retention and a **tested** restore; point-in-time recovery for money data.
- CI on every push: install, lint, tests, `npm audit`, build. Deploy only from a green main, and know the rollback (previous deploy one click away).
- A staging environment that mirrors production config, with seed data and separate keys (Paystack test mode etc.).
- No machine-specific paths (`C:/...`); config from env with sane defaults; the same Node/Python version locally and in production (`.nvmrc`, `engines`).
- Observability: request rate, error rate, p95 latency, DB connections, memory, queue depth; alerts on error spikes and failed health checks.

## F. "Works on my machine" - test the failure paths

For signup, login, payment, upload and checkout, test and handle: payment failed/declined, webhook late or duplicated (idempotent handlers), network drop/timeouts/double-submit, expired session mid-flow, duplicate email, invalid input, empty states, third-party service down or returning 429, and production-only differences (env vars, DB, CORS origin, HTTPS, timezone, read-only file system). Write integration/e2e tests for these and run them in CI.

## G. SEO (web frontends only)

1. Server-render or pre-render pages. 2. Real `<a href>` links. 3. Google Search Console. 4. `sitemap.xml` + `robots.txt`. 5. Hunt stray `noindex`. 6. Real 404 status codes. 7. One canonical URL per page. 8. Unique title + meta description per page. 9. Same content on mobile. 10. Image `alt` text. 11. JSON-LD structured data. 12. Pass Core Web Vitals. 13. Fact-check AI-written copy. 14. Google Business Profile for local businesses.

## H. UI: don't hand-roll components with AI

Use proven accessible libraries (Radix/shadcn, Headless UI, MUI, Chakra, Mantine; React Native Paper; Material 3) instead of custom dropdowns, modals, tabs, toasts and menus. Check keyboard-only navigation, visible focus, input labels, colour contrast and screen-reader names.

## Applying across many projects

List the projects, confirm scope, then run the steps per project on its own branch. One `PRODUCTION_AUDIT.md` per project, a "Production hardening — continue here" section in each CLAUDE.md, and a summary table in the workspace CLAUDE.md (project, stack, critical count, fixed, verified, remaining).
