const { deliver } = require("./mailTransport.js");

// Account emails for the developer platform and the apps built on it. Plain text plus
// simple HTML, sent in the background; failures are logged, never shown to the caller.

const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));

function sendReset({ to, name, appName, link }) {
    const subject = `Reset your ${appName} password`;
    const lines = [
        `Hi ${name || "there"},`,
        `We received a request to reset the password for your ${appName} account. The link works for 30 minutes and can be used once.`,
        "If you didn't ask for this, ignore this email: your password stays the same.",
    ];
    const text = [lines[0], "", lines[1], link, "", lines[2]].join("\n");
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:auto;color:#1b2430;line-height:1.6">
  <h2 style="margin:0 0 14px;font-size:20px">${escapeHtml(subject)}</h2>
  ${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("\n  ")}
  <p><a href="${escapeHtml(link)}" style="display:inline-block;background:#2f6feb;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:bold">Choose a new password</a></p>
  <p style="font-size:13px;color:#5b6573">If the button doesn't work, copy this link:<br>${escapeHtml(link)}</p>
</div>`;
    setImmediate(() => deliver({ fromName: appName, to, subject, text, html })
        .catch((err) => console.error(`[platform] reset email failed: ${err.message}`)));
}

module.exports = { sendReset };
