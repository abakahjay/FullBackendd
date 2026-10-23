// Hosted "forgot password" page for apps that have no reset screen of their own.
// /forgotPassword?app=shared|seedbridge|cleanbridge[&return=<the app's sign-in page>]
// The email links to /resetPassword?app=... on this server (utils/passwordReset.js).
(function () {
    const params = new URLSearchParams(window.location.search);
    const app = params.get("app");
    const base = app === "seedbridge" ? "/api/v1/seedbridge/auth"
        : app === "cleanbridge" ? "/api/v1/cleanbridge/auth"
            : "/api/v1/auth";

    // "Back to sign in" only for real http(s) links (never javascript: etc.).
    const back = document.getElementById("backLink");
    try {
        const ret = new URL(params.get("return") || "");
        if (ret.protocol === "https:" || ret.protocol === "http:") {
            back.href = ret.href;
            back.hidden = false;
        }
    } catch (e) { /* no return link */ }

    const form = document.getElementById("forgotForm");
    const message = document.getElementById("message");
    const button = document.getElementById("sendBtn");
    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const email = document.getElementById("email").value.trim();
        message.className = "message";
        if (!/^\S+@\S+\.\S+$/.test(email)) {
            message.className = "message error";
            message.textContent = "Enter a valid email address.";
            return;
        }
        button.disabled = true;
        button.textContent = "Sending…";
        try {
            const r = await fetch(`${base}/forgot-password`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email }),
            });
            const data = await r.json().catch(() => ({}));
            if (r.ok) {
                message.className = "message ok";
                message.textContent = (data.message || "If an account exists for that email, a reset link has been sent.") + " Check your spam folder too.";
                form.hidden = true;
            } else {
                message.className = "message error";
                message.textContent = data.msg || "Something went wrong. Please try again.";
            }
        } catch (err) {
            message.className = "message error";
            message.textContent = "Network error. Please try again.";
        } finally {
            button.disabled = false;
            button.textContent = "Send reset link";
        }
    });
})();
