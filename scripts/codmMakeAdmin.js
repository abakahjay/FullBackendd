// Make a registered CODM player an organiser (admin) so they can open /admin
// on the CODM site. Usage (from the backend folder, with .env pointing at the
// right database):   node scripts/codmMakeAdmin.js player@email.com
//                    node scripts/codmMakeAdmin.js player@email.com --remove
require("dotenv").config();
const mongoose = require("mongoose");
const CodmPlayer = require("../models/CodmPlayer.js");

(async () => {
    const email = String(process.argv[2] || "").trim().toLowerCase();
    const remove = process.argv.includes("--remove");
    if (!email) {
        console.log("Usage: node scripts/codmMakeAdmin.js <email> [--remove]");
        process.exit(1);
    }
    await mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    const player = await CodmPlayer.findOneAndUpdate(
        { email },
        { role: remove ? "player" : "admin", $inc: { tokenVersion: 1 } }, // they log in again to get the new role
        { new: true }
    );
    console.log(player ? `${player.email} is now ${player.role}. They must log in again.` : `No CODM player with email ${email}. Register on the site first.`);
    await mongoose.disconnect();
    process.exit(player ? 0 : 1);
})().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
