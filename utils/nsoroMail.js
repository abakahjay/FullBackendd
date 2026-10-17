const jwt = require("jsonwebtoken");
const { deliver, emailProvider } = require("./mailTransport");
const { pushToUser } = require("./push");

// Email for Nsoro: activity emails
// (new follower, comment, message while you're away) and admin "app update" emails.
// Same deliverability rules as utils/cleanbridgeMail.js: sent as EMAIL_USER via
// utils/mailTransport.js, plain text + simple HTML, RFC 8058 one-click unsubscribe.
const FROM_NAME = "Nsoro";
const enabled = Boolean(emailProvider);

// Links are opened on phones/other computers, so never point them at localhost.
const LIVE_SITE = "https://nsoro-app.onrender.com";
const isLocal = (url) => !url || /^https?:\/\/(localhost|127\.|0\.0\.0\.0|192\.168\.|10\.)/i.test(url);
const siteUrl = (path = "") => {
    const configured = process.env.NSORO_PUBLIC_URL;
    return `${(isLocal(configured) ? LIVE_SITE : configured).replace(/\/$/, "")}${path}`;
};
// The unsubscribe link must hit the server (and database) that sent the email.
const apiUrl = (path = "") => `${(process.env.ORIGIN || "http://localhost:7004").replace(/\/$/, "")}${path}`;

const PURPOSE = "nsoro-unsubscribe";
const unsubscribeToken = (userId) => jwt.sign({ uid: String(userId), purpose: PURPOSE }, process.env.JWT_SECRET);
const verifyUnsubscribeToken = (token) => {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.purpose !== PURPOSE) throw new Error("Wrong token purpose");
    return decoded.uid;
};

const escapeHtml = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Written to read like a short personal note, which is what keeps mail out of spam:
// plain text and HTML say the same thing, one link to the site, no big buttons,
// no images or tracking, a real reason why it was sent, and a working
// unsubscribe (link + List-Unsubscribe headers). Callers keep titles specific and
// name Nsoro in them ("x started following you on Nsoro"), never urgent or alarming.
const render = ({ name, title, message, cta, unsubscribeUrl }) => {
    const greeting = name ? `Hi ${name},` : "Hi,";
    const text = [
        greeting,
        "",
        message,
        cta ? `\n${cta.label}: ${cta.url}` : "",
        "",
        "Thanks,",
        "The Nsoro team",
        "",
        "--",
        `You got this email because you have a Nsoro account (${siteUrl().replace(/^https:\/\//, "")}) with email notifications on.`,
        `To stop these emails: ${unsubscribeUrl}`,
    ].join("\n");

    const paragraphs = String(message)
        .split(/\n{2,}/)
        .map((p) => `<p style="margin:0 0 14px;">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
        .join("");
    const link = cta
        ? `<p style="margin:0 0 14px;"><a href="${escapeHtml(cta.url)}" style="color:#0a7a4b;font-weight:600;">${escapeHtml(cta.label)}</a></p>`
        : "";

    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:24px 16px;background:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#222222;">
<div style="max-width:560px;margin:0 auto;">
<p style="margin:0 0 14px;">${escapeHtml(greeting)}</p>
${paragraphs}
${link}
<p style="margin:0 0 24px;">Thanks,<br>The Nsoro team</p>
<p style="margin:0;padding-top:12px;border-top:1px solid #e5e5e5;font-size:12px;line-height:1.5;color:#777777;">
You got this email because you have a Nsoro account with email notifications on.
<a href="${escapeHtml(unsubscribeUrl)}" style="color:#777777;">Unsubscribe</a>
</p>
</div>
</body></html>`;
    return { text, html };
};

// At most one email per recipient per kind in this window (e.g. a flurry of
// messages sends one "new messages" email). In memory - fine for one instance.
const THROTTLE_MS = 15 * 60 * 1000;
const lastSent = new Map();

/**
 * Send one email to a User. Never throws. Respects user.emailNotifications
 * unless force. `kind` + `throttle` limit repeats of activity emails.
 */
async function sendNsoroEmail(user, { title, message, cta, kind, throttle = false, force = false, push = true }) {
    if (push && user?._id) {
        pushToUser(user._id, {
            title,
            body: String(message || "").split(/\n{2,}/)[0],
            url: cta?.url ? cta.url.replace(/^https?:\/\/[^/]+/, "") || "/" : "/",
            tag: `ig-${kind || title}`.slice(0, 60),
        }, { app: "nsoro" });
    }
    if (!enabled || !user?.email) return false;
    if (user.emailNotifications === false && !force) return false;
    if (throttle && kind) {
        const key = `${user._id}:${kind}`;
        if (Date.now() - (lastSent.get(key) || 0) < THROTTLE_MS) return false;
        lastSent.set(key, Date.now());
    }

    const unsubscribeUrl = apiUrl(`/api/v1/nsoro/email/unsubscribe?token=${encodeURIComponent(unsubscribeToken(user._id))}`);
    const { text, html } = render({ name: user.firstName || user.username, title, message, cta, unsubscribeUrl });
    try {
        await deliver({
            fromName: FROM_NAME,
            replyTo: process.env.EMAIL_USER,
            to: { name: user.username, address: user.email },
            subject: title,
            text,
            html,
            headers: {
                "List-Unsubscribe": `<${unsubscribeUrl}>, <mailto:${process.env.EMAIL_USER}?subject=unsubscribe>`,
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            },
        });
        return true;
    } catch (err) {
        console.error("Nsoro email failed:", err.message);
        return false;
    }
}

module.exports = { sendNsoroEmail, verifyUnsubscribeToken, siteUrl, emailEnabled: enabled };
