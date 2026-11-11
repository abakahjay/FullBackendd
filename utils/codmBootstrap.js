const mongoose = require("mongoose");
const CodmPlayer = require("../models/CodmPlayer.js");

// Organiser accounts for the CODM site, created (or promoted) at startup, like
// CROPGUARD_BOOTSTRAP_ADMIN_*. Set on the server, never in code:
//   CODM_BOOTSTRAP_ADMIN_EMAILS=a@x.com,b@y.com
//   CODM_BOOTSTRAP_ADMIN_PASSWORD=<password>   (used only when an account is created)
// Sign-up refuses these emails (controllers/codmAuth.js), and an existing
// non-admin account with one of them is NOT promoted (someone else could have
// registered it first): use scripts/codmMakeAdmin.js for that. Never throws.
const adminEmails = () => String(process.env.CODM_BOOTSTRAP_ADMIN_EMAILS || "")
        .split(",").map((e) => e.trim().toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e));

const run = async () => {
    const emails = adminEmails();
    if (!emails.length) return;
    const password = process.env.CODM_BOOTSTRAP_ADMIN_PASSWORD || "";
    for (const email of emails) {
        try {
            const existing = await CodmPlayer.findOne({ email });
            if (existing) {
                if (existing.role !== "admin") console.log(`[codm] ${email} already has a player account; not promoting it automatically (scripts/codmMakeAdmin.js)`);
                continue;
            }
            if (password.length < 8) {
                console.log(`[codm] not creating admin ${email}: CODM_BOOTSTRAP_ADMIN_PASSWORD must be at least 8 characters`);
                continue;
            }
            const admin = new CodmPlayer({ fullName: "Organiser", email, ign: "Organiser", role: "admin" });
            await admin.setPassword(password);
            await admin.save();
            console.log(`[codm] admin account created for ${email}`);
        } catch (err) {
            console.log(`[codm] admin bootstrap failed for ${email}: ${err.message}`);
        }
    }
};

if (mongoose.connection.readyState === 1) run();
else mongoose.connection.once("open", run);

module.exports = { run, adminEmails };
