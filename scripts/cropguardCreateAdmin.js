// Create or promote a GhanaCropGuard administrator (asks for the password; it is never echoed).
//
//   node scripts/cropguardCreateAdmin.js admin@example.com
//
// Uses MONGO_URI from .env. An existing account is promoted to admin, gets the
// new password, and all its old tokens are revoked.
require("dotenv").config();
const readline = require("readline");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const validator = require("validator");
const connectDB = require("../db/connect.js");
const CropGuardUser = require("../models/CropGuardUser.js");
const { BCRYPT_ROUNDS, passwordProblem } = require("../utils/cropguard.js");

function askHidden(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        rl._writeToOutput = (s) => {
            if (s.startsWith(question)) rl.output.write(question);
        };
        rl.question(question, (answer) => {
            rl.close();
            process.stdout.write("\n");
            resolve(answer);
        });
    });
}

(async () => {
    const email = String(process.argv[2] || "").trim().toLowerCase();
    if (!validator.isEmail(email)) {
        console.error("Usage: node scripts/cropguardCreateAdmin.js <email>");
        process.exit(1);
    }
    const pw = await askHidden("Password (8+ chars, letters and numbers): ");
    const problem = passwordProblem(pw);
    if (problem) {
        console.error(problem);
        process.exit(1);
    }
    if (pw !== (await askHidden("Repeat password: "))) {
        console.error("Passwords do not match.");
        process.exit(1);
    }
    await connectDB(process.env.MONGO_URI);
    const passwordHash = await bcrypt.hash(pw, BCRYPT_ROUNDS);
    const user = await CropGuardUser.findOne({ email });
    if (user) {
        user.role = "admin";
        user.passwordHash = passwordHash;
        user.tokenVersion += 1;
        await user.save();
        console.log("Existing account promoted to admin and password updated.");
    } else {
        await CropGuardUser.create({ email, passwordHash, role: "admin", fullName: "Administrator" });
        console.log("Administrator created.");
    }
    await mongoose.disconnect();
    process.exit(0);
})().catch((err) => {
    console.error(`Failed: ${err.message}`);
    process.exit(1);
});
