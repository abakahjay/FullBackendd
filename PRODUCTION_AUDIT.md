# Production audit: FullBackendd

Branch: `hardening/production-ready` · Audited 2026-11-26 with the `production-ready-app` skill.
Stack: Node 22 · Express 4 · Mongoose 5 (MongoDB) · Socket.IO · Paystack · OpenAI/OpenRouter/Gemini · PM2/Render.

Overall, this backend is in better shape than most: Helmet, mongo-sanitize, xss-clean, a CORS policy, raw-body webhook signatures, upload caps, per-area auth and a Brevo email provider are already in place. The gaps were mostly in ordering, operations and data access.

## Fixed on this branch

| # | Area | Change | Where |
|---|------|--------|-------|
| 1 | Security | Helmet and the global `/api` rate limit now run **before** every router. Previously the upload, AI image/model, posts, stories, voice-notes, meals, GH-GPT upload, CropGuard, CODM and platform routes were mounted above them, so they got no security headers and no global limit. CSP stays per-area as before, and media can still be embedded cross-origin. | `app.js` |
| 2 | Secrets in logs | Morgan logged full URLs, and auth accepts tokens via `?oven=`. Tokens in `oven`, `token`, `access_token` and `code` query params are now redacted from request logs. | `app.js` |
| 3 | Log noise | Removed the `console.log('✅ Token verified')` that ran on every authenticated request. | `middleware/auth.js` |
| 4 | Scale: pooler | Mongo connection now uses an explicit pool (`MONGO_POOL_SIZE`, default 20), a 10s server-selection timeout (it fails fast instead of hanging requests) and a 45s socket timeout. | `db/connect.js` |
| 5 | Scale: indexes | Added indexes for the fields these collections are filtered and sorted by: Posts (`created`, `createdBy+created`), Comments (`post+created`), FoodOrders (`userId+createdAt`, `status+createdAt`), Token (`user`), UserOrder (`userId+weekStart`), UssdSession (`sessionId`), SeedBridgeProduce (`farmerId+createdAt`, `status+crop`), FoodFeedback (`orderId`, `userId+createdAt`). | `models/*` |
| 6 | Ops | `GET /healthz` returns 200 or 503 with the DB state, for Render/PM2/UptimeRobot. | `app.js` |
| 7 | Prod failure path | If Mongo is unreachable at boot, the process now exits(1) so PM2/Render restarts it. Before, it stayed alive serving nothing. | `app.js` |
| 8 | Prod failure path | Graceful SIGTERM/SIGINT shutdown: in-flight requests finish, Mongo closes, with a 10s hard stop. `unhandledRejection` is now logged. | `app.js` |
| 9 | "Works on my machine" | `/api/chat` hard-coded `C:/ProgramData/anaconda4/python.exe`, which doesn't exist on Linux hosts. It now reads `PYTHON_BIN` and keeps the old path as the default. | `app.js` |

New optional env vars: `MONGO_POOL_SIZE`, `MONGO_SERVER_SELECTION_MS`, `PYTHON_BIN`.

## Needs your decision (not changed: would break a frontend)

| Severity | Finding | Evidence | Recommended fix |
|---|---|---|---|
| 🔴 Critical | **Cart and Orders have no auth.** `GET /api/v1/cart` and `GET /api/v1/orders` return every user's carts and orders, and anyone can PATCH or DELETE any cart or order by id (IDOR). | `routes/cart.js`, `routes/orders.js`, `controllers/cart.js:12`, `controllers/orders.js:10` | Add `authMiddleware` and filter by `req.user.userId` (the models already have a User ref). Update the shop frontend to send the Bearer token. |
| 🔴 Critical | Same pattern to check: `/api/v1/delivery`, `/api/v1/ordersdata` (MTN orders), `/api/v1/afa` list, `/api/v1/foodorders` admin lists | `controllers/MTNOrders.js:7`, `afacontroller.js:31`, `foodorders.js` | Gate admin lists with `adminOnly`, and user lists by owner. |
| 🟠 High | Google OAuth open redirect: `redirect_uri` accepts any host, so a crafted link sends a real login token to an attacker's site. This is documented in CLAUDE.md as a deliberate tradeoff. | `utils/oauthRedirect.js` | Turn `isAllowedRedirectUri()` back on with `ALLOWED_REDIRECT_DOMAINS` listing your frontends. One env line per new app. |
| 🟠 High | JWT accepted in a query param (`?oven=`), which leaks into browser history, proxies and Referer headers. Logs are now redacted. | `middleware/auth.js` | Move those pages to the cookie or header and drop `?oven=`. |
| 🟡 Medium | Unbounded list endpoints (no pagination): posts feed (with `populate('comments')`), carts, orders, food orders, universities/programs | `postController.js:43` + list above | Add `?page=&limit=` with a max of 50–100, and return `nextCursor`. |
| 🟡 Medium | Socket.IO CORS is `origin: '*'`. It's mitigated by JWT auth on connect. | `app.js` | Reuse `utils/corsPolicy` origins. |
| 🟡 Medium | `createOrders` loads **all** orders (`Orders.find({})`) on every checkout to find a match by `orderTime`. This is O(n) per request. | `controllers/orders.js:41` | `Orders.findOne({ orderTime, createdBy })` with an index. |
| 🟡 Medium | Heavy jobs run inline in requests: AI generation, image processing (sharp), Excel export, email | `controllers/*` | Move them to a queue (BullMQ + Redis) when traffic grows. |
| 🟢 Low | Old/unused deps that are typosquat-prone or redundant: `crypto`, `https`, `stream`, `buffer`, `logger`, `rate-limiter`, plus many transitive deps listed directly. `xss-clean` is unmaintained. | `package.json` | Prune them, then run `npm audit`. |
| 🟢 Low | No automated tests for money flows: Paystack/MoMo charge fails, webhook arrives twice or late, refund funding. Only CropGuard/platform tests exist. | `test/` | Add `node --test` cases for the CODM/SeedBridge/CleanBridge payment failure paths. |

## Already good ✅
Parameterised Mongo queries plus `express-mongo-sanitize` · Helmet · per-area CSP · CORS allow-list for cookies · Paystack HMAC on the raw body · upload size and type limits · auth/password-reset limiters · trust-proxy for Render · real email provider (Brevo) with an SMTP fallback · OpenAI SDK built-in retries with backoff · JWT expiry via `JWT_LIFETIME` · `.env` not in git · admin-account audit on boot.

## Before deploying this branch
1. Run `npm start` locally and hit `/healthz`. Expect `{"status":"ok","db":"up"}`.
2. Upload a post image from Nsoro to confirm cross-origin media still loads.
3. Mongo builds the new indexes automatically on first boot. They are small collections, so this takes seconds.
