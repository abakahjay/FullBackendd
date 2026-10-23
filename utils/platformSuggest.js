const { collectionToDTO, validateAppSpec } = require("./platform.js");

// "Describe the API you want" for the developer dashboard.
//
// 1. Recommend what already exists (sign-in, uploads, password reset...) instead of
//    generating a duplicate, and say plainly what the platform does not do.
// 2. Draft a collection: from the AI when it is reachable, otherwise from vetted
//    templates. Either way the draft is only data and goes through validateAppSpec
//    exactly like a hand-written one, so a description (or a prompt-injected AI
//    answer) can never add code, operators or weaker rules than the validator allows.
//    Nothing is created until the developer reviews the draft and clicks Create.

const has = (text, words) => words.some((w) => new RegExp(`\\b${w}`, "i").test(text));

const BUILT_IN = [
    {
        words: ["login", "log in", "sign ?in", "sign ?up", "register", "account", "auth", "user"],
        feature: "auth",
        title: "Use the built-in user accounts",
        message: "Sign-up, sign-in, profile, change password, forgot/reset password and account deletion already exist for every app (POST /auth/register, /auth/login, GET /auth/me...). Turn on \"User accounts\"; you don't need a users collection.",
    },
    {
        words: ["upload", "image", "photo", "picture", "avatar", "file", "pdf", "document", "attachment"],
        feature: "files",
        title: "Use the built-in file uploads",
        message: "POST /files stores an image or PDF (max size and type checked) and returns an id you can save in a field of type \"file\". Turn on \"File uploads\".",
    },
    {
        words: ["forgot", "reset password"],
        feature: "auth",
        title: "Password reset is included",
        message: "Users get a reset link by email (POST /auth/forgot-password); the link opens your frontend's reset page.",
    },
];

const NOT_SUPPORTED = [
    { words: ["pay", "payment", "checkout", "momo", "mobile money", "card", "paystack", "stripe"], message: "Payments are not part of generated APIs: money must be handled by audited code. Store orders here and take payment with Paystack checkout from your own server." },
    { words: ["sms", "whatsapp", "text message"], message: "Sending SMS/WhatsApp is not available from generated APIs." },
    { words: ["chat in real ?time", "websocket", "live chat", "real-?time"], message: "Real-time push (websockets) is not available; poll the list endpoint or use the shared messaging API." },
    { words: ["send email", "newsletter", "email campaign"], message: "Bulk or marketing email is not available (only account emails like password reset)." },
];

// Vetted starting points. Access rules default to the safest sensible choice.
const TEMPLATES = [
    { words: ["todo", "to-do", "task", "checklist"], name: "tasks", access: { read: "owner", create: "signed_in" },
        fields: [{ name: "title", type: "string", required: true, max_length: 200 }, { name: "notes", type: "text" }, { name: "done", type: "boolean" }, { name: "due_date", type: "date" }, { name: "priority", type: "enum", values: ["low", "medium", "high"] }] },
    { words: ["product", "shop", "store", "item", "inventory", "catalog"], name: "products", access: { read: "public", create: "admin" },
        fields: [{ name: "name", type: "string", required: true, max_length: 120 }, { name: "description", type: "text" }, { name: "price", type: "number", required: true, min: 0 }, { name: "currency", type: "enum", values: ["GHS", "USD"] }, { name: "stock", type: "integer", min: 0 }, { name: "image", type: "file" }, { name: "tags", type: "string_list" }] },
    { words: ["order", "purchase", "cart"], name: "orders", access: { read: "owner", create: "signed_in" },
        fields: [{ name: "items", type: "string_list", required: true, max_items: 50 }, { name: "total", type: "number", min: 0 }, { name: "delivery_address", type: "string", max_length: 300 }, { name: "phone", type: "string", max_length: 20 }, { name: "status", type: "enum", values: ["pending", "paid", "shipped", "delivered", "cancelled"] }] },
    { words: ["blog", "post", "article", "news"], name: "posts", access: { read: "public", create: "signed_in" },
        fields: [{ name: "title", type: "string", required: true, max_length: 200 }, { name: "body", type: "text", required: true, max_length: 20000 }, { name: "cover", type: "file" }, { name: "tags", type: "string_list" }, { name: "published", type: "boolean" }] },
    { words: ["comment"], name: "comments", access: { read: "public", create: "signed_in" },
        fields: [{ name: "post_id", type: "string", required: true, max_length: 40 }, { name: "body", type: "text", required: true, max_length: 2000 }] },
    { words: ["review", "rating", "feedback"], name: "reviews", access: { read: "public", create: "signed_in" },
        fields: [{ name: "subject_id", type: "string", required: true, max_length: 40 }, { name: "rating", type: "integer", required: true, min: 1, max: 5 }, { name: "comment", type: "text", max_length: 2000 }] },
    { words: ["contact", "enquir", "inquir", "message us", "support request", "lead"], name: "messages", access: { read: "admin", create: "public" },
        fields: [{ name: "name", type: "string", required: true, max_length: 120 }, { name: "email", type: "email", required: true }, { name: "phone", type: "string", max_length: 20 }, { name: "message", type: "text", required: true, max_length: 3000 }] },
    { words: ["book", "appointment", "reservation", "schedule"], name: "bookings", access: { read: "owner", create: "signed_in" },
        fields: [{ name: "service", type: "string", required: true, max_length: 120 }, { name: "date", type: "date", required: true }, { name: "notes", type: "text", max_length: 1000 }, { name: "status", type: "enum", values: ["requested", "confirmed", "cancelled", "done"] }] },
    { words: ["event", "meetup", "conference"], name: "events", access: { read: "public", create: "admin" },
        fields: [{ name: "title", type: "string", required: true, max_length: 200 }, { name: "starts_at", type: "date", required: true }, { name: "venue", type: "string", max_length: 200 }, { name: "description", type: "text" }, { name: "cover", type: "file" }] },
    { words: ["note", "journal", "diary"], name: "notes", access: { read: "owner", create: "signed_in" },
        fields: [{ name: "title", type: "string", max_length: 200 }, { name: "body", type: "text", required: true, max_length: 20000 }, { name: "tags", type: "string_list" }] },
    { words: ["expense", "budget", "transaction", "spending", "income"], name: "transactions", access: { read: "owner", create: "signed_in" },
        fields: [{ name: "amount", type: "number", required: true }, { name: "kind", type: "enum", required: true, values: ["income", "expense"] }, { name: "category", type: "string", max_length: 60 }, { name: "date", type: "date", required: true }, { name: "note", type: "string", max_length: 300 }] },
    { words: ["job", "vacanc", "career"], name: "jobs", access: { read: "public", create: "admin" },
        fields: [{ name: "title", type: "string", required: true, max_length: 160 }, { name: "company", type: "string", max_length: 120 }, { name: "location", type: "string", max_length: 120 }, { name: "description", type: "text", required: true }, { name: "apply_url", type: "url" }, { name: "closes_on", type: "date" }] },
];

const nameFrom = (text) => {
    const word = (String(text).toLowerCase().match(/[a-z]{3,20}/g) || []).find((w) => !["want", "need", "store", "save", "keep", "list", "with", "that", "users", "the", "and", "for", "api", "app", "can", "let", "create", "add", "manage"].includes(w));
    if (!word) return "items";
    return word.endsWith("s") ? word : `${word}s`;
};

function templateFor(text) {
    const t = TEMPLATES.find((x) => has(text, x.words));
    if (t) return { name: t.name, access: { update: "owner", delete: "owner", ...t.access }, fields: t.fields };
    return {
        name: nameFrom(text),
        access: { read: "owner", create: "signed_in", update: "owner", delete: "owner" },
        fields: [{ name: "title", type: "string", required: true, max_length: 200 }, { name: "description", type: "text" }, { name: "status", type: "enum", values: ["active", "archived"] }],
    };
}

const SYSTEM = `You design ONE data collection for a REST API generator. Reply with JSON only, no prose:
{"name":"lowercase_plural","access":{"read":"public|signed_in|owner|admin","create":"public|signed_in|admin","update":"owner|admin","delete":"owner|admin"},"fields":[{"name":"snake_case","type":"string|text|number|integer|boolean|date|email|url|enum|string_list|file","required":true|false,"max_length":200,"values":["only","for","enum"],"min":0,"max":5}]}
Rules: 2-12 fields. No id, owner, password, created_at or updated_at fields (they are automatic; never store passwords). Prefer the most private access that still works: personal data -> read "owner"; contact/lead forms -> read "admin", create "public". Use "file" for images/documents, "enum" for fixed choices.`;

async function aiDraft(description) {
    if (process.env.PLATFORM_AI_SUGGESTIONS === "false") return null;
    try {
        const { completeChat } = require("./ghgptAi.js");
        const text = await Promise.race([
            completeChat({ maxTokens: 900, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: description }] }),
            new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 25000)),
        ]);
        const json = String(text).match(/\{[\s\S]*\}/);
        return json ? JSON.parse(json[0]) : null;
    } catch {
        return null; // fall back to the templates
    }
}

/** Run a draft through the real validator; returns the normalised collection or null. */
function vet(draft, existingNames) {
    if (!draft || typeof draft !== "object") return null;
    let name = String(draft.name || "").toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^[^a-z]+/, "").slice(0, 40) || "items";
    while (existingNames.includes(name)) name = `${name}_2`.slice(0, 40);
    try {
        const spec = validateAppSpec({ collections: [{ ...draft, name }] }, { partial: true });
        return collectionToDTO(spec.collections[0]);
    } catch {
        return null;
    }
}

async function suggest(description, app) {
    const text = String(description).slice(0, 1000);
    const existing = (app.collections || []).map((c) => c.name);
    const recommendations = [];
    for (const b of BUILT_IN) {
        if (has(text, b.words) && !recommendations.some((r) => r.feature === b.feature && r.title === b.title)) {
            recommendations.push({ kind: "feature", feature: b.feature, enabled: Boolean(app.features?.[b.feature] ?? b.feature === "auth"), title: b.title, message: b.message });
        }
    }
    for (const n of NOT_SUPPORTED) if (has(text, n.words)) recommendations.push({ kind: "not_supported", title: "Not available here", message: n.message });

    const lower = text.toLowerCase();
    for (const name of existing) {
        const stem = name.replace(/s$/, "");
        if (stem.length >= 3 && lower.includes(stem)) {
            recommendations.push({ kind: "existing", collection: name, title: `"${name}" already exists`, message: `Your app already has a "${name}" collection. Edit its fields instead of creating a second one.` });
        }
    }

    // Only sign-in/upload requests (no data to store) need no collection.
    const onlyBuiltIn = recommendations.length && recommendations.every((r) => r.kind === "feature")
        && !TEMPLATES.some((t) => has(text, t.words)) && !/\b(store|save|list|track|manage|record|collection|data)\b/i.test(text);
    if (onlyBuiltIn) return { recommendations, collection: null, source: "built_in" };

    const ai = await aiDraft(text);
    const fromAi = vet(ai, existing);
    const collection = fromAi || vet(templateFor(text), existing);
    // A draft with file fields needs uploads switched on.
    if (collection?.fields.some((f) => f.type === "file") && !app.features?.files && !recommendations.some((r) => r.feature === "files")) {
        recommendations.push({ kind: "feature", feature: "files", enabled: false, title: "This draft stores files", message: "It has a file field, so turn on file uploads (POST /files) or remove that field before creating it." });
    }
    return { recommendations, collection, source: fromAi ? "ai" : "template" };
}

module.exports = { suggest, templateFor };
