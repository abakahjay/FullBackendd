# Production audit: FullBackendd

Branch: `hardening/production-ready` · Audited 2026-11-26 with the `production-ready-app` skill (sections A–F; G/H apply to the frontends).
Stack: Node 22 · Express 4 · Mongoose 5 (MongoDB) · Socket.IO · Paystack · OpenAI/OpenRouter/Gemini · PM2/Render.

**Tests:** 64 automated tests, all passing on a throwaway MongoDB.

```
CROPGUARD_TEST_MONGO_URI=mongodb://127.0.0.1:27017/any_test npm run test:security    # 26: self-pentest + payment failure paths
CROPGUARD_TEST_MONGO_URI=mongodb://127.0.0.1:27017/any_test npm run test:cropguard   # 31
CROPGUARD_TEST_MONGO_URI=mongodb://127.0.0.1:27017/any_test npm run test:platform    # 7
```

No local MongoDB? Use `mongodb-memory-server` from a folder outside this repo (see CLAUDE.md). CI runs all three on every push (`.github/workflows/ci.yml`).

## Fixed on this branch

"Verified" means a test in `test/security/` attacks it and passes. Re-run it after any change.

| # | Sev | Finding | Fix | Verified |
|---|-----|---------|-----|----------|
| 1 | 🔴 | **`GET /api/v1/posts/user/:id` leaked the full user record of everyone who liked those posts: password hash, saved login tokens, reset tokens, email, phone.** Public, no login needed. **Confirmed on the live site 2026-11-26.** (`GET /api/v1/posts` itself didn't leak: `populate('user')` names a field the schema doesn't have.) | `models/User.js` `toJSON` drops `password`, `tokens`, `resetPassword*`, `verificationToken` from every JSON response; post populates select public fields only (`POST_USER_FIELDS`, also hides email/phone). **After deploying, rotate `JWT_SECRET`**: tokens that leaked stay valid until then. | ✅ `data leak` |
| 2 | 🔴 | **Stored XSS on the admin dashboard.** The public AFA sign-up stores `fullname` etc., and `static/afrodata.html` rendered them with `innerHTML` and inside an `onclick`. MTN order fields had the same issue on `dashboard.html`. | `esc()` helper in both pages; every server value is escaped. The edit and order-again buttons pass data through `data-*` + `JSON.parse` instead of building JS strings. | ✅ payload stored as text (`IDOR: AFA`); page code reviewed |
| 3 | 🔴 | **Cart/Orders IDOR.** Anyone could list every cart/order, and read, change or delete any of them by id. | `optionalAuth` + ownership (`utils/shop.js`). A cart/order with `createdBy` is visible only to its owner or an admin (404 otherwise). The Amazon demo's anonymous shared cart still works without a login. Listing every cart, creating and deleting carts need a login; editing/deleting orders is admin-only. | ✅ `IDOR: shop` |
| 4 | 🔴 | **AFA registrations (ID numbers, phones) and MTN data orders were world-readable and editable.** | `authMiddleware, adminOnly` on list/update/delete (the admin dashboard sends the `token` cookie). `GET /ordersdata/:email` returns only your own email's orders unless you are an admin. A non-admin creating an MTN order can't set `status` or `payment`. Update bodies are whitelisted. AFA sign-ups are no longer printed to the log. | ✅ `IDOR: AFA` |
| 5 | 🔴 | **Food orders, meals, feedback and UniServe writes trusted `userId`/`createdBy` from the body, with no auth.** Anyone could change meal prices, read anyone's orders, or post as anyone. | Food orders: login required, user taken from the token, staff routes `requireRole('admin','caterer')`, totals and admin analytics `adminOnly`. Meals/menus: writes need admin/caterer. Feedback: writes need a login, and editing or deleting is author/staff only. UniServe: adding universities/programs is admin-only (`middleware/writeGuard.js`). | ✅ `access: food orders` |
| 6 | 🟠 | JWT `alg` not pinned; tokens accepted from `?oven=` (leak via history/Referer/logs). | `algorithms: ['HS256']` on every `jwt.verify`. `?oven=` is off; only dead pages used it. `ALLOW_QUERY_TOKEN=true` turns it back on in an emergency. | ✅ `auth: alg:none…` |
| 7 | 🟠 | The login accepted objects (`{"$ne":null}`) and answered a confusing 404. Not a bypass (mongo-sanitize), but wrong. | Strings only, 400 otherwise. | ✅ `injection` |
| 8 | 🟠 | N+1 pricing: two DB queries per cart line on every cart change. `createOrders` loaded **all** orders on every checkout. | `priceLines()` uses 2 queries in total. Orders use `findOne({ orderTime, createdBy })` with new indexes. Cart/order lists are paginated (`?page=&limit=`, max 100). | ✅ |
| 9 | 🟡 | Business logic: negative, zero or huge quantities, non-ObjectId product ids, client-sent prices on carts. | `cleanProducts()` whitelists fields, quantity 1–100. Cart totals are always computed on the server. `await cart.save()` used to be missing, so validation errors were silently lost. | ✅ |
| 10 | 🟡 | Estimated delivery dates and `Posts.created` / `User.created` were frozen at server start (`dayJs()` at module load, `default: Date.now()`). | Computed per request; `default: Date.now`. | — |
| 11 | 🟡 | Unbounded lists: posts feed (with populate), MTN orders, AFA list. | Posts: max 500 without `?limit`, 100 per page with it. MTN/AFA: 500/1000 with `?page=`. | ✅ `?limit=1` |
| 12 | 🟡 | Socket.IO `origin: '*'`. | Reviewed and kept on purpose: every socket must present a JWT (`utils/socket.js`), no cookies (`credentials: false`), and the Nsoro web, TWA, Electron and Expo apps all have different origins. Added a 1 MB message cap and `pingTimeout`. `io.close()` on shutdown. | — |
| 13 | 🟢 | Typosquat-prone or unused deps shadowing Node built-ins: `crypto`, `https`, `stream`, `buffer`, plus `logger`, `rate-limiter`. Broken unused ESM `middleware/foodmiddleware.js`. | Removed. `npm audit fix` (non-breaking): 90 → 64 advisories. | ✅ all suites green after |
| 14 | Ops | No readiness probe, no env validation, `uncaughtException` not handled, no PM2 memory cap, no CI. | `GET /readyz` (real Mongo ping, 2 s cap, 503 while shutting down, memory stats). `utils/checkEnv.js`: the boot fails if `MONGO_URI`/`JWT_SECRET` are missing and warns on weak secrets. `uncaughtException` → graceful exit. `ecosystem.config.js` (`max_memory_restart` 450M, backoff). `.github/workflows/ci.yml`. | ✅ `ops` |
| 15 | Earlier | Helmet and the `/api` limiter before every router; morgan token redaction; Mongo pool and timeouts; `/healthz`; exit(1) on DB failure; graceful SIGTERM; `PYTHON_BIN`; indexes. | (commit `bfcc792`) | ✅ `ops`, `CORS`, `DoS` |

| 16 | 🔴 | **GH-GPT chats were world-readable and editable.** `/api/v1/ai/userchats/:userId`, `/chats/:userId/:chatId` (get/patch/delete, messages, search) and `/upload/:userId/:chatId` had no auth: the URL's user id was the only check, and user ids are public on every post. **Confirmed on live 2026-11-28** (anonymous → `200 "User Chats Found"`). | `authMiddleware` + `requireSelf('userId')` (`middleware/auth.js`): signed in as that user, else 401/404. GH-GPT sends its JWT on these calls (GHGPT repo, deploy it first). | ✅ `IDOR: GH-GPT` |
| 17 | 🔴 | **`DELETE /api/v1/ai/chats/image/:chatId/:fileId` deleted any GridFS file in `uploads`** (shared with Nsoro posts, voice notes and moments) before checking anything. | Auth; the chat must be the caller's and the file an image in it; only then delete. Invalid ids → 400. | ✅ `GridFS` |
| 18 | 🟠 | `POST /api/v1/ai/ask` (AI proxy) open to anonymous callers, and its multer had no size limit (memory). `POST /gpio/update` open. | Auth on both; `/ask` takes one image ≤ 10 MB. The global error handler now turns any `MulterError` into 413/400 instead of 500. | ✅ `IDOR: GH-GPT` (anonymous `/ask` → 401) |
| 19 | 🔴 | **Account takeover: `PATCH /api/v1/users/:username/editUser` needed no login** and could set anyone's email (then forgot-password → account, admins included). The other old social routes trusted client ids: post/like/comment/follow as anyone, delete any post (`DELETE /posts/image/:fileId`) or comment, change anyone's photo (`/userse/:username/editUserProfile`). | `middleware/legacySocialGuards.js`: sign-in, acting user from the token (`asSelfQuery`, `asSelfBody`, `requireSelf('id')`), own profile only (`selfUsername`), owner/admin for deletes (`ownPostFile`, `ownComment`). Auth runs before multer. `req.user.username` now comes from the DB (the token's goes stale after a rename). GH-GPT sends its token on all of these. | ✅ `legacy social routes` (fails on the old code) |
| 20 | 🔴 | **More open writes found by a sweep of every route:** `/api/v1/uploadFiles/delete|rename/:fileId` and `/upload/*` worked on the shared `uploads` bucket with no login (delete anyone's Nsoro media, voice notes, GH-GPT images); `/api/v1/bundles` POST/PUT/DELETE (anyone could change the MTN price list); `/reloadly/purchase` (airtime from the Reloadly balance; sandbox today, critical the day it goes live); `/muviin/initiate` (MoMo debit prompts to any number). | GridFS tools and bundle writes: `authMiddleware, adminOnly` (no client uses them). Reloadly and Muviin: login required; their static pages send the `token` cookie. | ✅ `open writes` |
| 21 | 🟠 | **Any user's email was public**: `GET /api/v1/users/:id` and `PATCH /users/:username` (profile lookups). Confirmed on live. | `optionalAuth`; email and phone only for the owner or an admin (`withoutContact`). No client shows another user's email. | ✅ `data leak: a profile` |

Also verified by attack test, no change needed: forged/unsigned Paystack webhooks (SeedBridge, CODM) are rejected; sign-up with `"role":"admin"` gives `user`; the login limiter answers 429; a 60 MB body gets 413 and the server stays up; malformed JSON has no stack trace; a foreign `Origin` gets no `Allow-Credentials`; `/.env`, `/.git/config`, `/app.js`, `/package.json` are not served.

**Payment failure paths (CODM webhook, `test/security/payments.test.js`)**, all ✅: wrong signature; declined charge; wrong amount, currency, player or app; duplicate and late webhooks (idempotent, `paidAt` unchanged); paying twice keeps the first reference; a refunded checkout never re-pays; unknown reference ignored; malformed JSON gives 400.

## Route sweep (2026-11-28)
Every `router.post|put|patch|delete` outside the isolated apps (CropGuard, CODM, platform, CleanBridge, SeedBridge, Nsoro, GH-GPT) was listed and checked for auth at the route, router or mount level. Left public on purpose: `POST /afa/register` (public sign-up form), `/ussd/start` and `/ussds` (Africa's Talking webhooks), `/push/ack|call-status|call-decline` (signed receipts), `/paystack/initiate` (creates a checkout only), `/jayrouter/backups` (HMAC-signed). Rows 16–21 came out of this sweep.

## Live check of the Render sites (2026-11-26, read-only)

Done against production **before** this branch was pushed, so it shows what is open right now. Nothing was written, no logins were attempted, and personal data was counted, never printed.

- Backend: helmet headers, HSTS and rate-limit headers present; `/.env`, `/.git` and the source are not served; no stack traces; forged JWTs (`alg:none`, garbage) are rejected; a foreign Origin gets no credentials.
- **Open on live, fixed in `main`:** `/posts/user/:id` secrets leak (row 1); anonymous `GET` on `/cart`, `/orders`, `/afa/registrations`, `/ordersdata`, `/foodorders/all`, `/foodorders/total`. `/orders` also returned old SeedBridge-era records (buyer names, delivery addresses, Paystack references) stored in the same collection; non-admins now only see shop orders (those with `orderTime`).
- Frontends (13 checked): all answer 200 except `ghanacropguard.onrender.com` (404, an old service: delete it on Render). No API keys found in any JS bundle. CORS preflights from Nsoro, GH-GPT, CleanBridge, CropGuard, portfolio, finance tracker and BillNova all pass. JayRouter's bundle still contains `http://localhost:8080`, and `seedbridge-blueprint` calls `openlabs-project-2` (the old backend copy), not FullBackendd. Check both.
- Free-plan cold start: the first request took 54 s. Use an uptime monitor on `/healthz` (that also keeps it warm) or a paid instance.

## CropGuard model accuracy (independent check)

`node scripts/cropguardEvaluate.js ../ghanacropguard-ai/ml/data --out report.json` runs the bundle the server serves (`mobilenetv3_large_100-1.1.0`) through the production `Classifier.predict()` on the 3,615 held-out test photos, which were never used for training or model selection.

| Metric | Result |
|---|---|
| Accuracy | **88.9%** (95% CI 87.8–89.9%); model card says 89.1% (agrees) |
| Top-3 accuracy | 99.0% (the right answer is almost always in the 3 shown) |
| Macro precision / recall (sensitivity) / specificity / F1 | 87.7% / 89.1% / 99.5% / 88.1% |
| Wrong crop | 0.2% |
| Calibration (ECE) | 0.082 (confidence is slightly over-stated) |
| Leaf check | 99.3% of real leaves accepted; **100% of 600** non-leaf photos (Imagenette) refused |
| Latency | p50 16 ms, p95 24 ms per photo on CPU |

Strong (F1 ≥ 92%): every cashew and cassava class except cassava brown spot (F1 91.9%), plus maize streak virus, fall armyworm, leaf beetle and grasshopper. **Weak:**
- tomato leaf curl (F1 62%)
- tomato verticillium wilt (F1 63%, recall 57%)
- tomato leaf blight (F1 68%)
- tomato septoria (F1 75%)
- maize healthy (precision 62%: maize leaf spot is called healthy 17 times out of 154, a missed disease)

Averaging the prediction with a flipped copy (TTA) only adds +0.5 pt, within noise, so it isn't used. To improve the weak classes: retrain on a GPU with a larger backbone (EfficientNet-B0/ConvNeXt-Tiny were benchmarked but never trained), add more and cleaner tomato and maize-leaf-spot photos (CCMT's tomato labels are known to be noisy), and keep the "preliminary assessment, not a diagnosis" wording plus the top-3 list, which is right 99% of the time.

## Needs your decision

| Sev | Item | Why it isn't done | Recommendation |
|-----|------|-------------------|----------------|
| 🔴 | **Weak `JWT_SECRET`.** The local `.env` secret is 17 characters; production is probably the same value. A short HS256 secret can be brute-forced offline from any token, which lets an attacker mint admin tokens. | Rotating it signs every user out of every app. | Generate 48 random bytes (command in `utils/checkEnv.js`), set it on Render, then set `REQUIRE_STRONG_SECRETS=true`. |
| 🔴 | **Secrets in git history.** `.env` was committed before (see CLAUDE.md), and the archived branches `archive/*` (imported from the old `FullBackendd-master` clone) contain `.env` too. | Rotation and history rewrites are owner actions. | Rotate the Paystack, OpenAI, Reloadly, Clerk and email keys. **Never push the `archive/*` branches.** |
| 🟠 | Google OAuth accepts any `redirect_uri` (open redirect for the login token). | Kept by the owner's choice (CLAUDE.md). | Turn on `isAllowedRedirectUri()` and list the frontends in `ALLOWED_REDIRECT_DOMAINS`. |
| 🟠 | 64 `npm audit` advisories need major upgrades: **mongoose 5 → 8** (most of the criticals, via the mongodb driver), nodemailer, sharp, multer, express-fileupload, imagekit, validator, path-to-regexp. | These change APIs. Mongoose 8 is a migration (callbacks, `useFindAndModify`, `execPopulate`, `strictQuery`). | One upgrade per PR, each with the test suites. Start with sharp/nodemailer/validator (drop-in), then mongoose. |
| 🟠 | `adminOnly` answers **401** to a signed-in non-admin. Some frontends treat any 401 as "session expired" and sign the user out. | Changing it to 403 changes behaviour for Nsoro admin pages. | Switch to `UnauthorizedError` (403) after checking Nsoro's API interceptor. |
| 🟡 | The Amazon demo shop has no login, so its anonymous cart/orders are shared by every visitor and editable by anyone (vandalism only; no personal data). | Needs a login in `React-products-master/Amazon`. | Add login → send the Bearer token → user-owned carts work automatically. |
| 🟡 | Heavy work runs inline in requests: AI generation, sharp, Excel export, email. | Needs Redis. | BullMQ + Redis when traffic grows. |
| 🟡 | Backups, error tracking and an uptime monitor are not set up (infra). | Needs accounts. | Atlas daily backups + **a tested restore**; Sentry (`@sentry/node`, DSN in env); UptimeRobot on `/readyz`. |
| 🟢 | More than one Render instance. | Rate limits and Socket.IO rooms are in memory. | `rate-limit-redis` + `@socket.io/redis-adapter` first. |
| 🟢 | `engines` / `.nvmrc` not pinned. | Render reads them and would switch Node versions on the next deploy. | Pin to the Node version Render runs today (check the deploy log). |

## Already good ✅
Parameterised Mongo queries + `express-mongo-sanitize` · Helmet (now before every router) · per-area CSP · CORS allow-list for cookies · Paystack HMAC on the raw body (SeedBridge, CODM) · idempotent CODM charge handling and refund claims · upload size/type limits and magic-byte checks (CropGuard, platform) · auth, sign-up and password-reset limiters · trust-proxy for Render · Gmail-relay/Brevo email (Render blocks SMTP) · SHA-256-hashed single-use reset tokens · token-version revocation (CropGuard, CODM, platform) · Socket.IO JWT auth · E2E-encrypted DMs.

## Before deploying this branch
1. `npm ci --legacy-peer-deps`, `npm start`, open `/healthz` and `/readyz`.
2. Log in on the MTN/AFA admin dashboard (`/afrodatadashboard`) as an admin: the AFA and orders tables must load (they now need the admin cookie).
3. Nsoro: open Explore/Search (uses `GET /api/v1/posts`) and upload a post.
4. Amazon demo: add to cart, change the quantity, place an order.
5. Set the three admin accounts (see CLAUDE.md), then watch the boot log for `[env] warning` lines.
