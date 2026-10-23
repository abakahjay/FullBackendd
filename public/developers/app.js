// FullBackend Developers dashboard. Plain ES module, no dependencies.
// Security: the page's CSP allows only this script; every value from the API is put in
// the DOM with textContent (el() below), never as HTML.
const API = "/api/v1/platform";
const ORIGIN = window.location.origin;
const TOKEN_KEY = "fb_dev_token";
const main = document.getElementById("main");
document.getElementById("year").textContent = new Date().getFullYear();

// ---------- tiny helpers ----------
const store = {
  get: () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set: (t) => { try { localStorage.setItem(TOKEN_KEY, t); } catch { /* private mode */ } },
  clear: () => { try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } },
};

/** el("div", { class: "x", onclick: fn }, child, "text") - text children become text nodes. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}
// Static, trusted icon markup only (never user data).
const ICONS = {
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  users: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M17 4a4 4 0 0 1 0 8m5 9a7 7 0 0 0-4-6.3"/>',
  db: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20"/>',
  wand: '<path d="m15 4 5 5L9 20l-5-5L15 4ZM14 2l1 2M20 8l2 1M3 3l2 2"/>',
  doc: '<path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h8M8 17h5"/>',
  gauge: '<path d="M12 14l4-4"/><path d="M3.3 19a10 10 0 1 1 17.4 0"/>',
};
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", "18"); svg.setAttribute("height", "18");
  svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round"); svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICONS[name] || "";
  return el("span", { class: "icon" }, svg);
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied"); } catch { toast("Copy failed: select the text instead"); }
}

class ApiError extends Error {
  constructor(status, detail) { super(detail?.message || "Something went wrong."); this.status = status; this.code = detail?.code; this.fields = detail?.fields || []; }
}
async function api(path, { method = "GET", json } = {}) {
  const headers = {};
  const token = store.get();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) headers["Content-Type"] = "application/json";
  let r;
  try {
    r = await fetch(`${API}${path}`, { method, headers, body: json !== undefined ? JSON.stringify(json) : undefined });
  } catch {
    throw new ApiError(0, { message: "You appear to be offline." });
  }
  if (r.status === 204) return null;
  const body = await r.json().catch(() => null);
  if (!r.ok) {
    if (r.status === 401 && token) { store.clear(); state.me = null; go("#/signin"); }
    throw new ApiError(r.status, body?.detail);
  }
  return body;
}

const go = (hash) => { if (window.location.hash !== hash) window.location.hash = hash; else render(); };
const state = { me: null, apps: null };

// ---------- shared UI pieces ----------
function errorBox(err) { return el("p", { class: "alert alert-bad", role: "alert", text: err.message }); }
function fieldErrors(form, err) {
  form.querySelectorAll(".field-error").forEach((n) => n.remove());
  for (const f of err.fields || []) {
    const input = form.querySelector(`[name="${CSS.escape(f.field.split(/[.[]/)[0])}"]`);
    const label = input?.closest("label");
    if (label) label.append(el("span", { class: "field-error", text: f.message }));
  }
}
function field(label, input, hint) {
  return el("label", { class: "field" }, label, input, hint ? el("span", { class: "field-hint", text: hint }) : null);
}
/** Wires a form: disables the button while busy and shows API errors in place. */
function onSubmit(form, button, fn) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const label = button.textContent;
    button.disabled = true;
    form.querySelector(".alert")?.remove();
    try {
      await fn(new FormData(form));
    } catch (err) {
      fieldErrors(form, err);
      if (!err.fields?.length) form.prepend(errorBox(err));
      else form.prepend(el("p", { class: "alert alert-bad", role: "alert", text: err.message }));
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  });
}

function topbar() {
  const box = document.getElementById("topbar-actions");
  box.replaceChildren(
    ...(state.me
      ? [el("a", { class: "btn btn-ghost btn-sm", href: "#/apps" }, "Dashboard"), el("a", { class: "btn btn-sm", href: "#/profile" }, state.me.name || "Profile")]
      : [el("a", { class: "btn btn-ghost btn-sm", href: "#/signin" }, "Sign in"), el("a", { class: "btn btn-primary btn-sm", href: "#/signup" }, "Get started")]),
  );
}

// ---------- landing ----------
function landing(section) {
  const snippet = el("pre", {},
    el("span", { class: "k", text: "await" }), " fetch(", el("span", { class: "s", text: '"https://fullbackendd.onrender.com/api/v1/apps/my-shop/data/products"' }), ", {\n",
    "  headers: { ", el("span", { class: "s", text: '"X-App-Key"' }), ": ", el("span", { class: "s", text: '"pk_…"' }), " }\n",
    "});\n", el("span", { class: "muted", text: "// → { items: [...], page: 1, total: 42 }" }));
  const feat = (ic, title, text) => el("div", { class: "card" }, icon(ic), el("h3", { text: title }), el("p", { text }));
  const page = el("div", {},
    el("section", { class: "wrap hero" },
      el("div", {},
        el("span", { class: "eyebrow" }, "For frontend developers"),
        el("h1", {}, "Your frontend. ", el("em", { text: "Our backend." }), " Live in minutes."),
        el("p", { class: "lead", text: "Register your site, describe the data your app needs in plain words, and get a secure REST API with user accounts, password reset, file uploads and docs. No server to write or host." }),
        el("div", { class: "hero-cta" },
          el("a", { class: "btn btn-primary btn-lg", href: state.me ? "#/apps" : "#/signup" }, state.me ? "Open dashboard" : "Create a free account"),
          el("a", { class: "btn btn-lg", href: "#/how" }, "See how it works"))),
      el("div", { class: "terminal", "aria-label": "Example request" }, el("div", { class: "terminal-bar" }, el("span"), el("span"), el("span")), snippet)),

    el("section", { class: "section", id: "about" }, el("div", { class: "wrap about" },
      el("div", {},
        el("span", { class: "eyebrow" }, "About"),
        el("h2", { text: "One backend behind many apps" }),
        el("p", { class: "intro", text: "FullBackend is the shared Express and MongoDB server that already runs GH-GPT, Nsoro, CleanBridge GH, SeedBridge and GhanaCropGuard AI. The developer platform opens it up: any frontend, a React site, a mobile app or a student project, can get its own isolated backend on it." })),
      el("ul", {},
        el("li", { text: "Each app gets its own users, data and files, isolated from every other app." }),
        el("li", { text: "You describe collections; the server validates every value against them." }),
        el("li", { text: "Develop against http://localhost, then add your production URL when you deploy." }),
        el("li", { text: "Nothing you submit is executed as code, so your app can't break anyone else's." })))),

    el("section", { class: "section", id: "features" }, el("div", { class: "wrap" },
      el("span", { class: "eyebrow" }, "Features"),
      el("h2", { text: "Everything a small app needs" }),
      el("div", { class: "grid-3" },
        feat("users", "User accounts", "Sign-up, sign-in, profile, change password, forgot/reset password by email and account deletion, out of the box."),
        feat("db", "Your own collections", "Typed fields (text, numbers, dates, emails, lists, choices, files) with list, filter, sort, create, update and delete routes."),
        feat("lock", "Access rules", "Per collection: public, signed-in users, the record's owner, or your server only. Enforced on every request."),
        feat("wand", "Describe it, we draft it", "Type what you need (\"a todo list per user\") and get a ready collection, or a pointer to a feature that already exists."),
        feat("file", "File uploads", "Images and PDFs, type-checked from the bytes, images stripped of location data, served from unguessable links."),
        feat("doc", "Live docs", "Every app has a docs endpoint listing its routes, fields and access rules, always in sync with your settings.")))),

    el("section", { class: "section", id: "how" }, el("div", { class: "wrap" },
      el("span", { class: "eyebrow" }, "How it works"),
      el("h2", { text: "From sign-up to first request" }),
      el("div", { class: "steps" },
        el("div", { class: "card" }, el("h3", { text: "Create an app" }), el("p", { text: "Give it a name. You get a publishable key for your frontend and a secret key for your own server." })),
        el("div", { class: "card" }, el("h3", { text: "Add your frontend URLs" }), el("p", { text: "e.g. https://myapp.onrender.com. Localhost on any port works while you develop." })),
        el("div", { class: "card" }, el("h3", { text: "Add APIs" }), el("p", { text: "Describe what you need and click Create, or start from a template. Routes are live at once." })),
        el("div", { class: "card" }, el("h3", { text: "Call it" }), el("p", { text: "Send X-App-Key with each request, plus the user's token once they sign in." }))))),

    el("section", { class: "section", id: "security" }, el("div", { class: "wrap" },
      el("span", { class: "eyebrow" }, "Security"),
      el("h2", { text: "Secure by default" }),
      el("div", { class: "grid-3" },
        feat("globe", "Your sites only", "Browsers may only use your key from the frontend URLs you registered. A secret key sent from a browser is refused."),
        feat("lock", "Strict validation", "Unknown fields, wrong types and query operators are rejected before anything reaches the database."),
        feat("gauge", "Limits and quotas", "Rate limits on sign-in and writes, record and storage quotas per app, bcrypt passwords, revocable sessions.")))),
  );
  main.replaceChildren(page);
  if (section) document.getElementById(section)?.scrollIntoView();
  else window.scrollTo(0, 0);
}

// ---------- auth pages ----------
function authCard(title, sub, form, footer) {
  return el("div", { class: "auth" }, el("div", { class: "card" }, el("h1", { text: title }), sub ? el("p", { class: "muted", text: sub }) : null, form, footer));
}
function signIn() {
  const btn = el("button", { class: "btn btn-primary", type: "submit" }, "Sign in");
  const form = el("form", { class: "form", novalidate: true },
    field("Email", el("input", { name: "email", type: "email", autocomplete: "email", required: true })),
    field("Password", el("input", { name: "password", type: "password", autocomplete: "current-password", required: true })),
    el("a", { href: "#/forgot", class: "small" }, "Forgot password?"), btn);
  onSubmit(form, btn, async (fd) => {
    btn.textContent = "Signing in…";
    const r = await api("/auth/login", { method: "POST", json: { email: fd.get("email"), password: fd.get("password") } });
    store.set(r.access_token); state.me = r.developer; state.apps = null; go("#/apps");
  });
  main.replaceChildren(authCard("Sign in", "Welcome back.", form, el("p", { class: "switch" }, "New here? ", el("a", { href: "#/signup" }, "Create an account"))));
}
function signUp() {
  const btn = el("button", { class: "btn btn-primary", type: "submit" }, "Create account");
  const form = el("form", { class: "form", novalidate: true },
    field("Your name", el("input", { name: "name", type: "text", autocomplete: "name" }), "Optional"),
    field("Email", el("input", { name: "email", type: "email", autocomplete: "email", required: true })),
    field("Password", el("input", { name: "password", type: "password", autocomplete: "new-password", required: true }), "At least 8 characters, with letters and numbers"),
    el("label", { class: "check" }, el("input", { type: "checkbox", name: "accept_terms" }),
      el("span", {}, "I'll use this for lawful apps, keep my secret key private, and I'm responsible for the data my app collects.")),
    btn);
  onSubmit(form, btn, async (fd) => {
    btn.textContent = "Creating…";
    const r = await api("/auth/register", { method: "POST", json: { name: fd.get("name") || null, email: fd.get("email"), password: fd.get("password"), accept_terms: fd.get("accept_terms") === "on" } });
    store.set(r.access_token); state.me = r.developer; state.apps = []; go("#/new");
  });
  main.replaceChildren(authCard("Create your developer account", "Free. Your apps, users and data stay separate from everyone else's.", form,
    el("p", { class: "switch" }, "Already have one? ", el("a", { href: "#/signin" }, "Sign in"))));
}
function forgot() {
  const btn = el("button", { class: "btn btn-primary", type: "submit" }, "Send reset link");
  const form = el("form", { class: "form", novalidate: true }, field("Email", el("input", { name: "email", type: "email", autocomplete: "email", required: true })), btn);
  onSubmit(form, btn, async (fd) => {
    btn.textContent = "Sending…";
    const r = await api("/auth/forgot-password", { method: "POST", json: { email: fd.get("email") } });
    form.replaceChildren(el("p", { class: "alert alert-good", role: "status", text: r.message }), el("p", { class: "muted small", text: "The link works for 30 minutes. Check your spam folder too." }));
  });
  main.replaceChildren(authCard("Forgot your password?", "We'll email you a link to choose a new one.", form, el("p", { class: "switch" }, el("a", { href: "#/signin" }, "Back to sign in"))));
}
function reset(params) {
  const token = params.get("token") || "";
  const email = params.get("email") || "";
  history.replaceState(null, "", "#/reset"); // drop the secret from the address bar
  const btn = el("button", { class: "btn btn-primary", type: "submit" }, "Save new password");
  const form = el("form", { class: "form", novalidate: true },
    el("p", { class: "muted", text: `For ${email || "your account"}` }),
    field("New password", el("input", { name: "new_password", type: "password", autocomplete: "new-password", required: true }), "At least 8 characters, with letters and numbers"),
    btn);
  onSubmit(form, btn, async (fd) => {
    btn.textContent = "Saving…";
    const r = await api("/auth/reset-password", { method: "POST", json: { email, token, new_password: fd.get("new_password") } });
    store.clear(); state.me = null;
    form.replaceChildren(el("p", { class: "alert alert-good", role: "status", text: `${r.message} Every device was signed out.` }), el("a", { class: "btn btn-primary", href: "#/signin" }, "Sign in"));
  });
  main.replaceChildren(authCard("Choose a new password", null, token ? form : el("p", { class: "alert alert-bad", text: "This reset link is incomplete. Request a new one." }),
    el("p", { class: "switch" }, el("a", { href: "#/forgot" }, "Request a new link"))));
}

// ---------- dashboard shell ----------
async function loadApps(force) {
  if (!state.apps || force) state.apps = (await api("/apps")).items;
  return state.apps;
}
function shell(active, content) {
  const side = el("nav", { class: "side", "aria-label": "Dashboard" },
    el("a", { href: "#/apps", class: active === "home" ? "active" : "" }, "Overview"),
    el("h4", { text: "Your apps" }),
    ...(state.apps || []).map((a) => el("a", { href: `#/apps/${a.id}/overview`, class: active === a.id ? "active" : "" }, el("span", { class: "dot" }), a.name)),
    el("a", { href: "#/new", class: active === "new" ? "active" : "" }, "+ New app"),
    el("h4", { text: "Account" }),
    el("a", { href: "#/profile", class: active === "profile" ? "active" : "" }, "Profile"),
    el("a", { href: "/api-docs", target: "_blank", rel: "noopener" }, "API reference"));
  main.replaceChildren(el("div", { class: "dash" }, side, el("div", { class: "content" }, content)));
}
const head = (title, sub, ...actions) => el("div", { class: "page-head" }, el("div", {}, el("h1", { text: title }), sub ? el("p", { text: sub }) : null), el("div", { class: "row" }, ...actions));

async function home() {
  const apps = await loadApps();
  const cards = apps.length
    ? el("div", { class: "grid-3" }, ...apps.map((a) => el("a", { class: "card", href: `#/apps/${a.id}/overview` },
      el("h3", { text: a.name }), el("p", { class: "mono small", text: a.api_base }),
      el("p", { class: "small", text: `${a.collections.length} collection(s) · ${a.frontend_urls.length} frontend URL(s)` }))))
    : el("div", { class: "card empty" }, el("h3", { text: "No apps yet" }), el("p", { text: "Create your first app to get an API." }), el("a", { class: "btn btn-primary", href: "#/new" }, "Create an app"));
  shell("home", el("div", { class: "stack" }, head(`Welcome${state.me?.name ? `, ${state.me.name}` : ""}`, "Your apps on FullBackend.", el("a", { class: "btn btn-primary", href: "#/new" }, "New app")), cards));
}

function urlsFromText(text) {
  return String(text || "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

async function newApp() {
  await loadApps();
  const btn = el("button", { class: "btn btn-primary", type: "submit" }, "Create app");
  const form = el("form", { class: "form card" },
    field("App name", el("input", { name: "name", type: "text", required: true, maxlength: 60, placeholder: "My Shop" })),
    field("Description", el("input", { name: "description", type: "text", maxlength: 500, placeholder: "What the app does (optional)" })),
    field("Frontend URLs", el("textarea", { name: "frontend_urls", placeholder: "https://myshop.onrender.com\nhttp://localhost:5173" }),
      "One per line. Only these sites may call your API from a browser. Use https, except for localhost."),
    el("label", { class: "check" }, el("input", { type: "checkbox", name: "allow_localhost", checked: true }), el("span", {}, "Allow any http://localhost port while I develop")),
    el("label", { class: "check" }, el("input", { type: "checkbox", name: "auth", checked: true }), el("span", {}, "User accounts (sign-up, sign-in, password reset)")),
    el("label", { class: "check" }, el("input", { type: "checkbox", name: "files" }), el("span", {}, "File uploads (images and PDFs)")),
    btn);
  onSubmit(form, btn, async (fd) => {
    btn.textContent = "Creating…";
    const app = await api("/apps", { method: "POST", json: {
      name: fd.get("name"), description: fd.get("description") || null, frontend_urls: urlsFromText(fd.get("frontend_urls")),
      allow_localhost: fd.get("allow_localhost") === "on", features: { auth: fd.get("auth") === "on", files: fd.get("files") === "on" }, collections: [],
    } });
    sessionStorage.setItem(`secret:${app.id}`, app.secret_key); // shown once on the next page, then forgotten
    await loadApps(true);
    go(`#/apps/${app.id}/overview`);
  });
  shell("new", el("div", { class: "stack" }, head("New app", "You can change everything later."), form));
}

// ---------- one app ----------
const TABS = [["overview", "Overview"], ["frontends", "Frontend URLs"], ["apis", "APIs"], ["usage", "Usage"], ["settings", "Settings"]];
async function appPage(id, tab) {
  const apps = await loadApps();
  let app = apps.find((a) => a.id === id);
  if (!app) { app = await api(`/apps/${encodeURIComponent(id)}`); }
  const tabs = el("nav", { class: "tabs", "aria-label": "App sections" }, ...TABS.map(([k, label]) => el("a", { href: `#/apps/${id}/${k}`, class: tab === k ? "active" : "", "aria-current": tab === k ? "page" : null }, label)));
  const body = el("div", { class: "stack" });
  shell(id, el("div", {}, head(app.name, app.description || app.api_base, el("a", { class: "btn btn-sm", href: app.docs_url, target: "_blank", rel: "noopener" }, "Live docs")), tabs, body));
  const views = { overview, frontends, apis, usage, settings };
  await (views[tab] || overview)(app, body);
}
const replaceApp = (app) => { state.apps = state.apps.map((a) => (a.id === app.id ? app : a)); };

function overview(app, body) {
  const secret = sessionStorage.getItem(`secret:${app.id}`);
  if (secret) {
    sessionStorage.removeItem(`secret:${app.id}`);
    body.append(el("div", { class: "secret-box stack" },
      el("strong", { text: "Your secret key: copy it now, it won't be shown again" }),
      el("div", { class: "row" }, el("code", { class: "copy grow", text: secret }), el("button", { class: "btn btn-sm", type: "button", onclick: () => copy(secret) }, "Copy")),
      el("p", { class: "small muted", text: "Use it only on a server (it acts as admin of this app). Never put it in frontend code: requests from a browser with it are refused." })));
  }
  const kv = (k, v, c) => [el("dt", { text: k }), el("dd", {}, v), c || el("span")];
  const pk = el("code", { class: "copy", text: app.publishable_key });
  body.append(
    el("div", { class: "card" }, el("dl", { class: "kv" },
      ...kv("API base", el("code", { class: "copy", text: app.api_base }), el("button", { class: "btn btn-sm", type: "button", onclick: () => copy(app.api_base) }, "Copy")),
      ...kv("Publishable key", pk, el("button", { class: "btn btn-sm", type: "button", onclick: () => copy(app.publishable_key) }, "Copy")),
      ...kv("Secret key", el("code", { class: "copy", text: app.secret_key_hint }), el("a", { class: "btn btn-sm", href: `#/apps/${app.id}/settings` }, "Rotate")),
      ...kv("Features", el("span", { class: "row" },
        el("span", { class: `pill ${app.features.auth ? "pill-good" : ""}`, text: `User accounts ${app.features.auth ? "on" : "off"}` }),
        el("span", { class: `pill ${app.features.files ? "pill-good" : ""}`, text: `File uploads ${app.features.files ? "on" : "off"}` }))),
      ...kv("Frontend URLs", el("span", { text: app.frontend_urls.join(", ") || "None yet" }), el("a", { class: "btn btn-sm", href: `#/apps/${app.id}/frontends` }, "Edit")))),
    el("div", { class: "card stack" }, el("h3", { text: "Quick start" }),
      el("p", { class: "muted small", text: "From your frontend (React, Vue, plain JS, React Native):" }),
      el("pre", { class: "snippet", text: quickStart(app) })),
  );
}
function quickStart(app) {
  const col = app.collections[0]?.name || "your_collection";
  return [
    `const API = "${app.api_base}";`,
    `const KEY = "${app.publishable_key}";`,
    "",
    app.features.auth ? "// sign up (or /auth/login) and keep the token" : "",
    app.features.auth ? 'const { access_token } = await (await fetch(`${API}/auth/register`, {\n  method: "POST",\n  headers: { "Content-Type": "application/json", "X-App-Key": KEY },\n  body: JSON.stringify({ email, password }),\n})).json();' : "",
    "",
    `// list ${col}`,
    `const res = await fetch(\`\${API}/data/${col}?page=1\`, {`,
    "  headers: { \"X-App-Key\": KEY" + (app.features.auth ? ", Authorization: `Bearer ${access_token}`" : "") + " },",
    "});",
    "const { items, total } = await res.json();",
  ].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
}

function frontends(app, body) {
  const list = el("div", { class: "list" });
  let urls = [...app.frontend_urls];
  const draw = () => list.replaceChildren(...(urls.length ? urls : [null]).map((u) => (u
    ? el("div", { class: "list-item" }, el("span", { class: "grow mono", text: u }),
      el("button", { class: "btn btn-sm btn-danger", type: "button", onclick: () => { urls = urls.filter((x) => x !== u); draw(); } }, "Remove"))
    : el("div", { class: "list-item muted" }, "No frontend URLs yet."))));
  draw();
  const input = el("input", { type: "url", name: "frontend_urls", placeholder: "https://myapp.onrender.com or http://localhost:5173", class: "grow" });
  const add = () => {
    const v = input.value.trim();
    let origin;
    try { const u = new URL(v); if (!/^https?:$/.test(u.protocol)) throw new Error(); origin = u.origin; } catch { toast("Enter a full URL starting with https:// (or http://localhost)"); return; }
    if (!urls.includes(origin)) urls.push(origin);
    input.value = "";
    draw();
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
  const localhost = el("input", { type: "checkbox", name: "allow_localhost", checked: app.allow_localhost || null });
  const save = el("button", { class: "btn btn-primary", type: "submit" }, "Save frontend URLs");
  const form = el("form", { class: "form" },
    el("div", { class: "card stack" },
      el("h3", { text: "Where your frontend runs" }),
      el("p", { class: "muted small", text: "Browsers may only call this app's API from these origins (scheme + host + port). Paths are ignored. Use https in production; http is accepted only for localhost." }),
      list, el("div", { class: "row" }, input, el("button", { class: "btn", type: "button", onclick: add }, "Add"))),
    el("div", { class: "card stack" },
      el("h3", { text: "Local development" }),
      el("label", { class: "check" }, localhost, el("span", {}, "Allow any http://localhost and http://127.0.0.1 port (Vite, Create React App, Expo web…)")),
      el("p", { class: "muted small", text: "Turn this off when the app is finished, or add only the exact port you use (e.g. http://localhost:5173) above." })),
    el("div", {}, save));
  onSubmit(form, save, async () => {
    save.textContent = "Saving…";
    const updated = await api(`/apps/${app.id}`, { method: "PATCH", json: { frontend_urls: urls, allow_localhost: localhost.checked } });
    replaceApp(updated); toast("Frontend URLs saved");
  });
  body.append(form);
}

const ACCESS_TEXT = { public: "anyone", signed_in: "signed-in users", owner: "the owner", admin: "your server only" };
function collectionCard(app, col, onRemove) {
  const base = `${app.api_base}/data/${col.name}`;
  return el("div", { class: "card stack" },
    el("div", { class: "row" }, el("h3", { class: "grow", text: col.name }),
      onRemove ? el("button", { class: "btn btn-sm btn-danger", type: "button", onclick: onRemove }, "Delete") : null),
    el("div", { class: "row small" }, ...["read", "create", "update", "delete"].map((k) => el("span", { class: "pill", text: `${k}: ${ACCESS_TEXT[col.access[k]] || col.access[k]}` }))),
    el("div", { class: "scroll-x" }, el("table", { class: "fields" },
      el("thead", {}, el("tr", {}, el("th", { text: "Field" }), el("th", { text: "Type" }), el("th", { text: "Rules" }))),
      el("tbody", {}, ...col.fields.map((f) => el("tr", {},
        el("td", { class: "mono", text: f.name }), el("td", { text: f.type }),
        el("td", { class: "muted", text: [f.required ? "required" : "optional", f.max_length ? `max ${f.max_length} chars` : "", f.values ? f.values.join(" | ") : "", f.min !== undefined ? `min ${f.min}` : "", f.max !== undefined ? `max ${f.max}` : ""].filter(Boolean).join(" · ") })))))),
    el("p", { class: "small muted mono", text: `GET/POST ${base} · GET/PATCH/DELETE ${base}/:id` }));
}

function apis(app, body) {
  // 1. describe it
  const desc = el("textarea", { name: "description", maxlength: 1000, placeholder: "e.g. A list of products with a price, a photo and a category that only I can edit, and customers can leave reviews with a 1-5 rating" });
  const suggestBtn = el("button", { class: "btn btn-primary", type: "submit" }, "Suggest an API");
  const result = el("div", { class: "stack" });
  const form = el("form", { class: "form" }, field("Describe what you want", desc, "Plain words are fine. Nothing is created until you review the draft and click Create."), el("div", {}, suggestBtn));
  onSubmit(form, suggestBtn, async (fd) => {
    suggestBtn.textContent = "Thinking…";
    const s = await api(`/apps/${app.id}/suggest`, { method: "POST", json: { description: fd.get("description") } });
    showSuggestion(app, s, result);
  });
  body.append(el("div", { class: "card stack" }, el("h3", { text: "Add an API" }), form, result));

  // 2. existing collections
  body.append(el("h3", { text: `Your collections (${app.collections.length})` }));
  if (!app.collections.length) body.append(el("div", { class: "card empty" }, "No collections yet. Describe one above, or build it by hand below."));
  for (const col of app.collections) {
    body.append(collectionCard(app, col, async () => {
      if (!window.confirm(`Delete "${col.name}" and all its records? This cannot be undone.`)) return;
      const updated = await api(`/apps/${app.id}/collections/${encodeURIComponent(col.name)}`, { method: "DELETE" });
      replaceApp(updated); toast(`Deleted ${col.name}`); render();
    }));
  }

  // 3. by hand
  const json = el("textarea", { class: "code", name: "collection", spellcheck: "false" });
  json.value = JSON.stringify({ name: "items", access: { read: "public", create: "signed_in", update: "owner", delete: "owner" }, fields: [{ name: "title", type: "string", required: true, max_length: 200 }, { name: "done", type: "boolean" }] }, null, 2);
  const manualBtn = el("button", { class: "btn", type: "submit" }, "Create collection");
  const manual = el("form", { class: "form" }, field("Collection (JSON)", json, "Types: string, text, number, integer, boolean, date, email, url, enum (with values), string_list, file. Access: read public|signed_in|owner|admin, create public|signed_in|admin, update/delete owner|admin."), el("div", {}, manualBtn));
  onSubmit(manual, manualBtn, async (fd) => {
    let parsed;
    try { parsed = JSON.parse(fd.get("collection")); } catch { throw new ApiError(422, { message: "That isn't valid JSON." }); }
    await createCollection(app, parsed);
  });
  body.append(el("details", { class: "card" }, el("summary", {}, "Build a collection by hand"), el("div", { class: "stack" }, manual)));
}

async function createCollection(app, collection) {
  const updated = await api(`/apps/${app.id}/collections`, { method: "POST", json: collection });
  replaceApp(updated);
  toast(`Created ${collection.name}: routes are live`);
  render();
}

function showSuggestion(app, s, box) {
  const recs = s.recommendations.map((r) => el("div", { class: `alert ${r.kind === "not_supported" ? "alert-warn" : ""}` },
    el("strong", { text: r.title }), el("div", { class: "small", text: r.message }),
    r.kind === "feature" && !app.features[r.feature]
      ? el("button", { class: "btn btn-sm", type: "button", onclick: async () => {
        const updated = await api(`/apps/${app.id}`, { method: "PATCH", json: { features: { [r.feature]: true } } });
        replaceApp(updated); toast("Turned on"); render();
      } }, r.feature === "auth" ? "Turn on user accounts" : "Turn on file uploads")
      : null,
    r.kind === "existing" ? el("a", { class: "small", href: `#/apps/${app.id}/apis` }, "See it below") : null));
  const parts = [...recs];
  if (s.collection) {
    const editor = el("textarea", { class: "code", spellcheck: "false" });
    editor.value = JSON.stringify(s.collection, null, 2);
    const createBtn = el("button", { class: "btn btn-primary", type: "submit" }, `Create "${s.collection.name}"`);
    const f = el("form", { class: "form" }, el("details", {}, el("summary", { class: "small" }, "Edit before creating (JSON)"), editor), el("div", { class: "row" }, createBtn, el("span", { class: "small muted", text: s.source === "ai" ? "Drafted by AI and checked by the validator." : "From a vetted template." })));
    onSubmit(f, createBtn, async () => {
      let parsed;
      try { parsed = JSON.parse(editor.value); } catch { throw new ApiError(422, { message: "That isn't valid JSON." }); }
      createBtn.textContent = "Creating…";
      await createCollection(app, parsed);
    });
    parts.push(el("h4", { text: "Proposed collection" }), collectionCard(app, s.collection), f);
  } else if (!recs.length) {
    parts.push(el("p", { class: "muted", text: "Nothing to create for that. Try describing the data you want to store." }));
  }
  box.replaceChildren(...parts);
}

async function usage(app, body) {
  const s = await api(`/apps/${app.id}/stats`);
  const tile = (label, value, sub) => el("div", { class: "card" }, el("p", { class: "muted small", text: label }), el("div", { class: "stat", text: value }), el("p", { class: "small muted", text: sub }));
  const records = Object.values(s.records).reduce((a, b) => a + b, 0);
  body.append(
    el("div", { class: "grid-3" },
      tile("Users", String(s.users), `limit ${s.limits.users.toLocaleString()}`),
      tile("Records", String(records), `limit ${s.limits.records.toLocaleString()}`),
      tile("File storage", `${s.storage_mb} MB`, `limit ${s.limits.storage_mb} MB`)),
    el("div", { class: "list" }, ...(app.collections.length ? app.collections.map((c) => el("div", { class: "list-item" }, el("span", { class: "grow mono", text: c.name }), el("span", { text: String(s.records[c.name] || 0) }))) : [el("div", { class: "list-item muted" }, "No collections yet.")])),
    el("p", { class: "small muted", text: "To see your users or private records, call GET /admin/users or the data routes from your server with the secret key." }));
}

function settings(app, body) {
  const save = el("button", { class: "btn btn-primary", type: "submit" }, "Save");
  const auth = el("input", { type: "checkbox", checked: app.features.auth || null });
  const files = el("input", { type: "checkbox", checked: app.features.files || null });
  const general = el("form", { class: "form card" },
    el("h3", { text: "General" }),
    field("App name", el("input", { name: "name", type: "text", value: app.name, maxlength: 60 })),
    field("Description", el("input", { name: "description", type: "text", value: app.description || "", maxlength: 500 })),
    el("label", { class: "check" }, auth, el("span", {}, "User accounts")),
    el("label", { class: "check" }, files, el("span", {}, "File uploads")),
    el("p", { class: "small muted", text: `Slug: ${app.slug} (part of your API address; it can't change)` }), el("div", {}, save));
  onSubmit(general, save, async (fd) => {
    const updated = await api(`/apps/${app.id}`, { method: "PATCH", json: { name: fd.get("name"), description: fd.get("description") || null, features: { auth: auth.checked, files: files.checked } } });
    replaceApp(updated); toast("Saved"); render();
  });
  const action = (title, text, label, fn, danger) => el("div", { class: "list-item" },
    el("div", { class: "grow" }, el("strong", { text: title }), el("div", { class: "small muted", text })),
    el("button", { class: `btn btn-sm ${danger ? "btn-danger" : ""}`, type: "button", onclick: fn }, label));
  const del = el("input", { type: "text", placeholder: app.slug, "aria-label": "Type the slug to confirm" });
  body.append(general,
    el("div", { class: "list" },
      action("Rotate the secret key", "The old secret key stops working immediately.", "Rotate", async () => {
        if (!window.confirm("Rotate the secret key? Your server must be updated with the new one.")) return;
        const r = await api(`/apps/${app.id}/rotate-secret`, { method: "POST" });
        sessionStorage.setItem(`secret:${app.id}`, r.secret_key); replaceApp(r); go(`#/apps/${app.id}/overview`);
      }),
      action("Rotate the publishable key", "Update it in your frontend right after.", "Rotate", async () => {
        if (!window.confirm("Rotate the publishable key? Your frontend stops working until you update it.")) return;
        replaceApp(await api(`/apps/${app.id}/rotate-publishable-key`, { method: "POST" })); toast("New publishable key"); go(`#/apps/${app.id}/overview`);
      }),
      action("Sign out every user", "All your users must sign in again (e.g. after a leak).", "Sign out all", async () => {
        if (!window.confirm("Sign out every user of this app?")) return;
        await api(`/apps/${app.id}/sign-out-users`, { method: "POST" }); toast("Every user was signed out");
      })),
    el("div", { class: "card stack" }, el("h3", { class: "btn-danger", text: "Delete this app" }),
      el("p", { class: "small muted", text: "Deletes the app, its users, records and files. Type the slug to confirm." }),
      el("div", { class: "row" }, el("span", { class: "grow" }, del), el("button", { class: "btn btn-danger", type: "button", onclick: async () => {
        try {
          await api(`/apps/${app.id}`, { method: "DELETE", json: { confirm: del.value.trim() } });
          state.apps = state.apps.filter((a) => a.id !== app.id); toast("App deleted"); go("#/apps");
        } catch (err) { toast(err.message); }
      } }, "Delete app"))));
}

// ---------- profile ----------
function profile() {
  const me = state.me;
  const nameBtn = el("button", { class: "btn btn-primary", type: "submit" }, "Save");
  const details = el("form", { class: "form card" }, el("h3", { text: "Your details" }),
    field("Name", el("input", { name: "name", type: "text", value: me.name || "", maxlength: 120, autocomplete: "name" })),
    field("Email", el("input", { type: "email", value: me.email, disabled: true }), "Your sign-in email"),
    el("p", { class: "small muted", text: `Member since ${new Date(me.created_at).toLocaleDateString()}` }), el("div", {}, nameBtn));
  onSubmit(details, nameBtn, async (fd) => { state.me = await api("/auth/me", { method: "PATCH", json: { name: fd.get("name") || null } }); toast("Saved"); topbar(); });

  const pwBtn = el("button", { class: "btn", type: "submit" }, "Change password");
  const pw = el("form", { class: "form card" }, el("h3", { text: "Password" }),
    field("Current password", el("input", { name: "current_password", type: "password", autocomplete: "current-password" })),
    field("New password", el("input", { name: "new_password", type: "password", autocomplete: "new-password" }), "At least 8 characters, with letters and numbers. Signs you out everywhere."),
    el("div", {}, pwBtn));
  onSubmit(pw, pwBtn, async (fd) => {
    await api("/auth/me/password", { method: "POST", json: { current_password: fd.get("current_password"), new_password: fd.get("new_password") } });
    store.clear(); state.me = null; toast("Password changed. Please sign in again."); go("#/signin");
  });

  const delPw = el("input", { type: "password", autocomplete: "current-password", "aria-label": "Password" });
  shell("profile", el("div", { class: "stack" }, head("Profile", "Your developer account."), details, pw,
    el("div", { class: "list" },
      el("div", { class: "list-item" }, el("div", { class: "grow" }, el("strong", { text: "Sign out" }), el("div", { class: "small muted", text: "On this browser." })),
        el("button", { class: "btn btn-sm", type: "button", onclick: () => { store.clear(); state.me = null; state.apps = null; go("#/"); } }, "Sign out")),
      el("div", { class: "list-item" }, el("div", { class: "grow" }, el("strong", { text: "Sign out everywhere" }), el("div", { class: "small muted", text: "Every browser and device." })),
        el("button", { class: "btn btn-sm", type: "button", onclick: async () => { await api("/auth/logout-all", { method: "POST" }); store.clear(); state.me = null; go("#/signin"); } }, "Sign out everywhere"))),
    el("div", { class: "card stack" }, el("h3", { class: "btn-danger", text: "Delete account" }),
      el("p", { class: "small muted", text: "Deletes your developer account and every app you own, with their users, records and files." }),
      el("div", { class: "row" }, el("span", { class: "grow" }, delPw), el("button", { class: "btn btn-danger", type: "button", onclick: async () => {
        if (!window.confirm("Delete your account and all your apps? This cannot be undone.")) return;
        try { await api("/auth/me", { method: "DELETE", json: { password: delPw.value } }); store.clear(); state.me = null; state.apps = null; go("#/"); toast("Account deleted"); } catch (err) { toast(err.message); }
      } }, "Delete account")))));
}

// ---------- router ----------
async function render() {
  const hash = window.location.hash || "#/";
  if (hash.startsWith("#reset")) return reset(new URLSearchParams(hash.replace(/^#reset&?/, "")));
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (store.get() && !state.me) {
    try { state.me = await api("/auth/me"); } catch { /* signed out */ }
  }
  topbar();
  document.querySelectorAll("[data-public]").forEach((a) => a.classList.toggle("hidden", Boolean(state.me) && parts[0] && !["about", "features", "how"].includes(parts[0])));
  const needsAuth = ["apps", "new", "profile"].includes(parts[0]);
  if (needsAuth && !state.me) return signIn();
  if (state.me && ["signin", "signup"].includes(parts[0])) return go("#/apps");
  try {
    switch (parts[0]) {
      case undefined: return landing();
      case "about": case "features": case "how": return landing(parts[0]);
      case "signin": return signIn();
      case "signup": return signUp();
      case "forgot": return forgot();
      case "reset": return reset(new URLSearchParams());
      case "new": return await newApp();
      case "profile": return profile();
      case "apps": return parts[1] ? await appPage(parts[1], parts[2] || "overview") : await home();
      default: return landing();
    }
  } catch (err) {
    main.replaceChildren(el("div", { class: "wrap section" }, errorBox(err), el("a", { class: "btn", href: "#/apps" }, "Back to dashboard")));
  }
}
window.addEventListener("hashchange", () => { render(); main.focus({ preventScroll: true }); });
render();
