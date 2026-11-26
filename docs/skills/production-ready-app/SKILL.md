---
name: production-ready-app
description: Audit and harden a backend, web app or mobile app for production - security, scale to 1,000+ users, SEO, accessible UI, and real-world failure paths. Use when making an app production-ready, keeping a backend up under real users without errors, or applying the hardening checklist to a project.
---

# Production-ready app audit & hardening

Use when the user asks to make an app/backend production-ready, "check my app", "will it survive real users", keep the backend up without errors, harden a vibe-coded project, or apply this skill to their projects.

## How to run it

1. **Map the project first.** Detect stack (package.json, requirements.txt, pyproject, go.mod, pom.xml/build.gradle, pubspec.yaml, Supabase/Firebase config, Dockerfile). Find entry points, routes/controllers, DB layer, auth, env/config, frontend pages. Read the project's CLAUDE.md and PRODUCTION_AUDIT.md if they exist. Note which sections below apply (a pure API has no SEO section; a static site has no DB section).
2. **Audit before editing.** Walk every applicable checklist item, citing `file:line` evidence. Rate each: done / partial / missing / N/A.
3. **Write or update `PRODUCTION_AUDIT.md`** at the project root: summary, findings grouped by severity (Critical > High > Medium > Low), each with evidence and the concrete fix.
4. **Fix in safe, small commits** on a branch (`hardening/production-ready`). Critical security items first. Never change behaviour silently: no schema-destroying migrations, no dependency major bumps, no secret rotation, no auth added to a route a frontend relies on, without asking. Add tests for each fix where a test setup exists.
5. **Verify.** Run the project's build, linter and tests after changes. Report what was fixed and what is left for the user (anything needing credentials, paid services, infra or product decisions). Record both in CLAUDE.md under a "Production hardening" section.

## A. Security

- **SQL/NoSQL injection** - parameterized queries / ORM only; no string-built queries; sanitize Mongo operators.
- **XSS** - output encoding; no `dangerouslySetInnerHTML`/`innerHTML`/`v-html` with user data; set a Content-Security-Policy.
- **Rate limiting** - on auth, signup, password reset, OTP, AI and any expensive endpoint (per-IP and per-user). Limiter and security headers must be registered before every router.
- **Secrets management** - no keys in source, client bundles, logs or git history; `.env` in `.gitignore`; server-only keys never shipped to the browser/app.
- **JWT** - short-lived access tokens, rotating refresh tokens, verify signature + `exp`; never accept tokens in query strings where avoidable; redact them from logs.
- **Auth & authorization** - every route checks *who* and *whether they may touch this record* (IDOR). Supabase: RLS on every table.
- **Input validation** - schema validation (zod/joi/pydantic) at every boundary; size limits on bodies and uploads.
- **CORS, CSRF, security headers** - explicit allowed origins; CSRF protection for cookie auth; HSTS, nosniff, frame-ancestors.
- **Open redirects** - redirect targets checked against an allow-list.
- **DDoS protection** - CDN/WAF in front; request timeouts; body size limits.
- **Dependency audit** - `npm audit` / `pip-audit`; prune unused and typosquat-prone packages.

## B. Scale: survive 1,000+ concurrent users

1. **Real email provider** - Resend/Postmark/SES/Brevo, not dev SMTP or Gmail SMTP.
2. **Index what you search** - every field used in filters, joins, sorts and foreign keys.
3. **Speed up RLS policies** - `(select auth.uid())`, index policy columns.
4. **Use the connection pooler** - one shared pool per process with explicit size and fail-fast timeouts.
5. **Kill N+1 queries** - eager-load or batch instead of querying in a loop; never load a whole collection to find one record.
6. **Paginate every list** - cursor or limit/offset with a max page size.
7. **Cache what's the same** - CDN/HTTP cache headers for public data; Redis/in-memory for hot reads.
8. **Retry AI/external calls with backoff** - exponential backoff + jitter, timeouts, idempotency keys; handle 429s.
9. **Slow jobs in a queue** - email, media processing, AI generations, exports, webhooks -> BullMQ/Celery with retries.
10. **Check realtime limits** - connection/message limits; unsubscribe on unmount; authenticate sockets.
11. **Load-test before launch** - k6/Artillery at 1,000 virtual users; watch DB CPU, connections, p95 latency.

Also: reverse proxy, load balancing, feature flags, forward-only migrations, memory-leak watch (unbounded caches, listeners).

## C. Stay up without errors (operations)

- `GET /healthz` reporting DB state; wire it to the host's health check and an uptime monitor.
- Exit non-zero when a required dependency (DB) is unreachable at boot so the process manager restarts it.
- Graceful SIGTERM shutdown: stop accepting, finish in-flight, close DB, hard-stop after ~10s.
- Log `unhandledRejection`/`uncaughtException`; error tracking (Sentry or similar); structured logs without secrets.
- One central error handler with consistent JSON errors; async errors always reach it.
- No machine-specific paths (`C:/...`) - read them from env with a default.

## D. SEO (web frontends only)

Server-render or pre-render; real `<a href>` links; Google Search Console; `sitemap.xml` + `robots.txt`; no stray `noindex`; real 404 status codes; one canonical URL per page; unique title + meta description; same content on mobile; image `alt` text; JSON-LD structured data; pass Core Web Vitals; fact-check AI-written copy; Google Business Profile for local businesses.

## E. UI: don't hand-roll components with AI

Use proven accessible libraries (Radix/shadcn, Headless UI, MUI, Chakra, Mantine; React Native Paper; Material 3) instead of custom dropdowns, modals, tabs and menus. Check keyboard navigation, visible focus, labels, contrast.

## F. "Works on my machine" - test the failure paths

For signup, login, payment, upload and checkout, test and handle: payment failed/declined, webhook late or duplicated (idempotent handlers), network drop/timeouts/double-submit, expired session, duplicate email, invalid input, empty states, third-party down or 429, and prod-only differences (env vars, DB, CORS, HTTPS, timezone). Write integration/e2e tests for these.

## Applying across many projects

List the projects, confirm scope, then run steps 1-5 per project on its own branch. One `PRODUCTION_AUDIT.md` per project, and a "Production hardening" section in each CLAUDE.md saying what changed and what's next.
