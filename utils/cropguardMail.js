const { deliver } = require("./mailTransport.js");

// GhanaCropGuard AI account emails (password reset, security notices).
// Sent through utils/mailTransport.js (Gmail relay / Brevo / SMTP, picked by env),
// as plain text plus simple HTML with no images or tracking, so they reach the inbox.
// Callers never await delivery in the request path: failures are logged, never shown.

const APP_NAME = "GhanaCropGuard AI";

const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));

const layout = (title, paragraphs, button) => `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:auto;color:#1c2a1f;line-height:1.6">
  <p style="margin:0 0 4px;font-size:13px;color:#5d6b60">${APP_NAME}</p>
  <h2 style="margin:0 0 14px;font-size:20px">${escapeHtml(title)}</h2>
  ${paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n  ")}
  ${button ? `<p><a href="${escapeHtml(button.href)}" style="display:inline-block;background:#e0b13b;color:#14120c;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:bold">${escapeHtml(button.label)}</a></p>
  <p style="font-size:13px;color:#5d6b60">If the button doesn't work, copy this link:<br>${escapeHtml(button.href)}</p>` : ""}
  <p style="font-size:12px;color:#7a867c;margin-top:24px">You received this because of activity on your ${APP_NAME} account. It is a preliminary crop-health aid, not a diagnosis.</p>
</div>`;

function send(user, subject, text, html) {
    setImmediate(() => deliver({ fromName: APP_NAME, to: user.email, subject, text, html })
        .catch((err) => console.error(`[cropguard] email "${subject}" failed: ${err.message}`)));
}

function sendPasswordReset(user, link) {
    const hi = `Hi ${user.fullName || "there"},`;
    const lines = [
        hi,
        `We received a request to reset the password for your ${APP_NAME} account. The link works for 30 minutes and can be used once.`,
        "If you didn't ask for this, ignore this email: your password stays the same.",
    ];
    send(
        user,
        `Reset your ${APP_NAME} password`,
        [lines[0], "", lines[1], link, "", lines[2]].join("\n"),
        layout("Reset your password", lines, { href: link, label: "Choose a new password" }),
    );
}

function sendPasswordChanged(user) {
    const lines = [
        `Hi ${user.fullName || "there"},`,
        `The password for your ${APP_NAME} account was just changed, and every device was signed out.`,
        "If this wasn't you, use \"Forgot password\" on the sign-in page straight away to take the account back.",
    ];
    send(user, `Your ${APP_NAME} password was changed`, lines.join("\n\n"), layout("Your password was changed", lines));
}

module.exports = { sendPasswordChanged, sendPasswordReset };
