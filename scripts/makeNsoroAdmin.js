// Give one or more shared users the 'admin' role (Nsoro /admin/updates and reports, GH-GPT,
// the MTN/AFA dashboard, food orders and shop admin all check User.role).
//
//   node --env-file .env scripts/makeNsoroAdmin.js <username or email> [more ...]
//
// Runs against whatever MONGO_URI is in .env - point it at the database the live
// site uses (Atlas) to make the admin there.
const mongoose = require('mongoose');
const User = require('../models/User');

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

(async () => {
    const names = process.argv.slice(2);
    if (!names.length) throw new Error('Usage: node --env-file .env scripts/makeNsoroAdmin.js <username or email> [more ...]');
    await mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    for (const name of names) {
        const filter = name.includes('@')
            ? { email: new RegExp(`^${escape(name.trim())}$`, 'i') }
            : { username: name };
        const user = await User.findOneAndUpdate(filter, { role: 'admin' }, { new: true });
        console.log(user ? `${user.username} (${user.email}) is now an admin.` : `No user named ${name}.`);
    }
    await mongoose.disconnect();
})().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
