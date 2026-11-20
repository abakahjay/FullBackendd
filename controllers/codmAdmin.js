const { StatusCodes } = require("http-status-codes");
const CodmPlayer = require("../models/CodmPlayer.js");
const CodmTeam = require("../models/CodmTeam.js");
const CodmPayment = require("../models/CodmPayment.js");
const { eventConfig, teamStatus, pesewas, check } = require("../utils/codm.js");
const { BadRequestError, NotFoundError } = require("../errors");

const playerRow = (p, captainId) => ({
    id: String(p._id),
    fullName: p.fullName,
    ign: p.ign,
    codmUid: p.codmUid,
    phone: p.phone,
    email: p.email,
    paid: !!p.paid,
    paidAt: p.paidAt,
    paymentChannel: p.paymentChannel,
    role: p.role,
    manualPayment: String(p.paymentReference || "").startsWith("cash_"),
    refundedAt: p.refundedAt || null,
    isCaptain: captainId ? String(p._id) === String(captainId) : false,
    createdAt: p.createdAt,
});

const buildOverview = async () => {
    const cfg = eventConfig();
    const [teams, players, payments] = await Promise.all([
        CodmTeam.find().sort({ createdAt: 1 }).lean(),
        CodmPlayer.find({ isActive: true }).sort({ createdAt: 1 }).lean(),
        CodmPayment.find({ status: "success" }).select("amountPesewas").lean(),
    ]);
    const byId = new Map(players.map((p) => [String(p._id), p]));
    const teamRows = teams.map((t) => {
        const members = t.members.map((id) => byId.get(String(id))).filter(Boolean);
        return { id: String(t._id), name: t.name, tag: t.tag, inviteCode: t.inviteCode, createdAt: t.createdAt, members: members.map((m) => playerRow(m, t.captainId)), ...teamStatus(t, members) };
    });
    const noTeam = players.filter((p) => !p.teamId).map((p) => playerRow(p));
    return {
        event: cfg,
        totals: {
            players: players.length,
            paidPlayers: players.filter((p) => p.paid).length,
            teams: teams.length,
            confirmedTeams: teamRows.filter((t) => t.confirmed).length,
            collectedGhs: payments.reduce((s, p) => s + p.amountPesewas, 0) / 100,
        },
        teams: teamRows,
        playersWithoutTeam: noTeam,
    };
};

// GET /api/v1/codm/admin/overview
const overview = async (req, res) => {
    res.status(StatusCodes.OK).json(await buildOverview());
};

// GET /api/v1/codm/admin/export.csv  (team sheet for match day)
const exportCsv = async (req, res) => {
    const data = await buildOverview();
    // Leading = + - @ would run as a formula in Excel: prefix with '.
    const cell = (v) => {
        let s = v === null || v === undefined ? "" : String(v);
        if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
        return `"${s.replace(/"/g, '""')}"`;
    };
    const rows = [["Team", "Tag", "Team confirmed", "Captain", "Full name", "IGN", "CODM UID", "Phone", "Email", "Paid", "Paid at", "Channel"]];
    data.teams.forEach((t) => t.members.forEach((m) => rows.push([t.name, t.tag, t.confirmed ? "YES" : "no", m.isCaptain ? "C" : "", m.fullName, m.ign, m.codmUid, m.phone, m.email, m.paid ? "YES" : "no", m.paidAt ? new Date(m.paidAt).toISOString() : "", m.paymentChannel])));
    data.playersWithoutTeam.forEach((m) => rows.push(["(no team)", "", "", "", m.fullName, m.ign, m.codmUid, m.phone, m.email, m.paid ? "YES" : "no", m.paidAt ? new Date(m.paidAt).toISOString() : "", m.paymentChannel]));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="codm-registrations.csv"');
    res.status(StatusCodes.OK).send(`﻿${rows.map((r) => r.map(cell).join(",")).join("\r\n")}`);
};

// PATCH /api/v1/codm/admin/players/:playerId/paid  { paid: true | false }
// For entry fees paid in cash or to the organiser's MoMo directly. Recorded with
// the admin's id; online (Paystack) payments cannot be undone here.
const setPaid = async (req, res) => {
    const playerId = check.objectId(req.params.playerId, "player");
    const paid = (req.body || {}).paid;
    if (typeof paid !== "boolean") throw new BadRequestError("paid must be true or false");
    const player = await CodmPlayer.findById(playerId);
    if (!player) throw new NotFoundError("Player not found");
    if (paid && !player.paid) {
        const reference = `cash_${player._id}_${Date.now()}`;
        const wanted = (req.body || {}).channel;
        const channel = MANUAL_CHANNELS.includes(wanted) ? wanted : "Cash";
        await CodmPayment.create({ reference, playerId: player._id, amountPesewas: pesewas(eventConfig().entryFeeGhs), status: "success", channel, paidAt: new Date() });
        Object.assign(player, { paid: true, paidAt: new Date(), paymentReference: reference, paymentChannel: channel });
    } else if (!paid && player.paid) {
        if (!String(player.paymentReference || "").startsWith("cash_")) throw new BadRequestError("This player paid online with Paystack; refund it in Paystack instead.");
        if (player.teamId) throw new BadRequestError("Remove the player from their team first.");
        await CodmPayment.updateOne({ reference: player.paymentReference }, { status: "failed" });
        Object.assign(player, { paid: false, paidAt: null, paymentReference: null, paymentChannel: null });
    }
    await player.save();
    require("../utils/codm.js").clearPublicCache();
    res.status(StatusCodes.OK).json(await buildOverview());
};

// PATCH /api/v1/codm/admin/players/:playerId  { fullName?, ign?, codmUid?, phone?, email? }
// Organisers can correct any player's details (their own included), and the channel of an
// entry they recorded (paymentChannel: Cash | MTN MoMo | Telecel Cash | AirtelTigo Money). Same validation
// as sign-up; role, payment and password are never changed here.
const DUPLICATE = { email: "Another account already uses this email.", phone: "Another account already uses this phone number.", codmUid: "Another account already uses this CODM UID." };
const MANUAL_CHANNELS = ["Cash", "MTN MoMo", "Telecel Cash", "AirtelTigo Money"];
const updatePlayer = async (req, res) => {
    const playerId = check.objectId(req.params.playerId, "player");
    const b = req.body || {};
    const player = await CodmPlayer.findById(playerId);
    if (!player) throw new NotFoundError("Player not found");
    if (b.fullName !== undefined) player.fullName = check.text(b.fullName, "Full name", { min: 2, max: 60 });
    if (b.ign !== undefined) player.ign = check.ign(b.ign);
    if (b.codmUid !== undefined) player.codmUid = check.codmUid(b.codmUid);
    if (b.phone !== undefined) player.phone = check.phone(b.phone);
    if (b.email !== undefined) player.email = check.email(b.email);
    // How an organiser-recorded entry was paid (cash or MoMo straight to the organiser).
    // Paystack payments keep the channel Paystack reported.
    if (b.paymentChannel !== undefined) {
        if (!String(player.paymentReference || "").startsWith("cash_")) throw new BadRequestError("Only entries recorded by an organiser can have their channel changed.");
        if (!MANUAL_CHANNELS.includes(b.paymentChannel)) throw new BadRequestError(`Channel must be one of: ${MANUAL_CHANNELS.join(", ")}`);
        player.paymentChannel = b.paymentChannel;
        await CodmPayment.updateOne({ reference: player.paymentReference }, { channel: b.paymentChannel });
    }
    try {
        await player.save();
    } catch (err) {
        if (err.code === 11000) throw new BadRequestError(DUPLICATE[Object.keys(err.keyValue || err.keyPattern || {})[0]] || "Another account already has those details.");
        throw err;
    }
    require("../utils/codm.js").clearPublicCache();
    res.status(StatusCodes.OK).json(await buildOverview());
};

// DELETE /api/v1/codm/admin/players/:playerId  { confirm: "<the player's email>" }
// Removes an account that has not paid and is not in a team (duplicates, mistakes),
// including another organiser's (never your own, never the last one). An organiser
// listed in CODM_BOOTSTRAP_ADMIN_EMAILS is created again on restart: remove it there too.
// Paid players must be refunded first so no money is ever left without an owner.
const deletePlayer = async (req, res) => {
    const playerId = check.objectId(req.params.playerId, "player");
    const player = await CodmPlayer.findById(playerId);
    if (!player) throw new NotFoundError("Player not found");
    if ((req.body || {}).confirm !== player.email) throw new BadRequestError("Confirm with the player's email address.");
    if (String(player._id) === String(req.player._id)) throw new BadRequestError("You can't delete your own account here.");
    if (player.role === "admin" && (await CodmPlayer.countDocuments({ role: "admin" })) < 2) throw new BadRequestError("This is the last organiser account, so it can't be deleted.");
    if (player.paid) throw new BadRequestError("This player has paid. Refund them first, then delete the account.");
    if (player.teamId) throw new BadRequestError("Take the player out of their team first.");
    await CodmPayment.deleteMany({ playerId: player._id, status: { $ne: "success" } });
    await CodmPlayer.deleteOne({ _id: player._id, paid: false, teamId: null });
    console.log(`[codm] admin ${req.player.email} deleted player ${player.email}`);
    require("../utils/codm.js").clearPublicCache();
    res.status(StatusCodes.OK).json(await buildOverview());
};

module.exports = { overview, exportCsv, setPaid, updatePlayer, deletePlayer };
