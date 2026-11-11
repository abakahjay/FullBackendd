const mongoose = require("mongoose");
const { StatusCodes } = require("http-status-codes");
const CodmPlayer = require("../models/CodmPlayer.js");
const CodmTeam = require("../models/CodmTeam.js");
const { BadRequestError, NotFoundError, UnauthorizedError } = require("../errors");
const { eventConfig, registrationOpen, check, newInviteCode, toMemberDTO, teamStatus, cachedPublic, clearPublicCache, PUBLIC_CACHE_MS } = require("../utils/codm.js");

const publicHeaders = (res) => res.set("Cache-Control", `public, max-age=${Math.round(PUBLIC_CACHE_MS / 1000)}, stale-while-revalidate=30`);

const CodmBracket = require("../models/CodmBracket.js");

// Team changes stop when registration closes or once the bracket has been drawn.
const assertOpen = async () => {
    if (!registrationOpen()) throw new BadRequestError("Registration is closed. Contact the organiser on WhatsApp.");
    if (await CodmBracket.exists({ _id: "main" })) throw new BadRequestError("The bracket has been drawn, so teams are locked. Contact the organiser.");
};

// Paying the entry fee is what registers a player: only paid players can be in a team.
const assertPaid = (player) => {
    if (!player.paid) throw new BadRequestError("Pay your GH₵ entry fee first. Paying is what registers you for the tournament.");
};

const loadMembers = (team) => CodmPlayer.find({ _id: { $in: team.members } }).select("fullName ign phone paid createdAt");

const toMyTeamDTO = async (team) => {
    clearPublicCache(); // called after every team change
    const members = await loadMembers(team);
    // Keep join order (members array), captain first.
    const order = new Map(team.members.map((id, i) => [String(id), i]));
    members.sort((a, b) => (String(a._id) === String(team.captainId) ? -1 : String(b._id) === String(team.captainId) ? 1 : order.get(String(a._id)) - order.get(String(b._id))));
    return {
        id: String(team._id),
        name: team.name,
        tag: team.tag,
        inviteCode: team.inviteCode,
        captainId: String(team.captainId),
        createdAt: team.createdAt,
        members: members.map((m) => toMemberDTO(m, team.captainId)),
        ...teamStatus(team, members),
    };
};

// GET /api/v1/codm/event  (public)
const buildEvent = async () => {
    const cfg = eventConfig();
    const [teams, players, paidList] = await Promise.all([
        CodmTeam.find().select("members").lean(),
        CodmPlayer.countDocuments({ isActive: true, role: "player" }),
        CodmPlayer.find({ paid: true }).select("_id").lean(),
    ]);
    const paidIds = new Set(paidList.map((p) => String(p._id)));
    const confirmedTeams = teams.filter((t) => t.members.length === cfg.teamSize && t.members.every((id) => paidIds.has(String(id)))).length;
    return {
        ...cfg,
        registrationOpen: registrationOpen(),
        teamsRegistered: teams.length,
        teamSlotsLeft: Math.max(0, cfg.maxTeams - teams.length),
        confirmedTeams,
        players,
        paidPlayers: paidIds.size,
    };
};

const getEvent = async (req, res) => {
    publicHeaders(res);
    res.status(StatusCodes.OK).json({ event: await cachedPublic("event", PUBLIC_CACHE_MS, buildEvent) });
};

// GET /api/v1/codm/teams  (public: names, tags, game names and counts only)
const buildTeams = async () => {
    const teams = await CodmTeam.find().sort({ createdAt: 1 }).lean();
    const ids = teams.flatMap((t) => t.members);
    const players = await CodmPlayer.find({ _id: { $in: ids } }).select("ign paid").lean();
    const byId = new Map(players.map((p) => [String(p._id), p]));
    const list = teams.map((t) => {
        const members = t.members.map((id) => byId.get(String(id))).filter(Boolean);
        return { id: String(t._id), name: t.name, tag: t.tag, players: members.map((m) => m.ign), ...teamStatus(t, members) };
    });
    list.sort((a, b) => Number(b.confirmed) - Number(a.confirmed) || b.paidCount - a.paidCount);
    return { teams: list, teamSize: eventConfig().teamSize };
};

const listTeams = async (req, res) => {
    publicHeaders(res);
    res.status(StatusCodes.OK).json(await cachedPublic("teams", PUBLIC_CACHE_MS, buildTeams));
};

// GET /api/v1/codm/teams/mine
const getMyTeam = async (req, res) => {
    if (!req.player.teamId) return res.status(StatusCodes.OK).json({ team: null });
    const team = await CodmTeam.findById(req.player.teamId);
    if (!team) {
        await CodmPlayer.updateOne({ _id: req.player._id }, { teamId: null });
        return res.status(StatusCodes.OK).json({ team: null });
    }
    res.status(StatusCodes.OK).json({ team: await toMyTeamDTO(team) });
};

// POST /api/v1/codm/teams  { name, tag? }  - the caller becomes captain
const createTeam = async (req, res) => {
    await assertOpen();
    const b = req.body || {};
    assertPaid(req.player);
    const name = check.teamName(b.name);
    const tag = check.teamTag(b.tag);
    const cfg = eventConfig();
    if (req.player.teamId) throw new BadRequestError("You are already in a team. Leave it first.");
    if ((await CodmTeam.countDocuments()) >= cfg.maxTeams) throw new BadRequestError("All team slots are taken.");
    if (await CodmTeam.exists({ nameKey: name.toLowerCase() })) throw new BadRequestError("That team name is taken. Pick another.");

    const teamId = new mongoose.Types.ObjectId();
    // Claim the player first (atomic), so two quick clicks can't create two teams.
    const claimed = await CodmPlayer.findOneAndUpdate({ _id: req.player._id, teamId: null }, { teamId }, { new: true });
    if (!claimed) throw new BadRequestError("You are already in a team. Leave it first.");

    let team;
    for (let attempt = 0; attempt < 5 && !team; attempt += 1) {
        try {
            team = await CodmTeam.create({ _id: teamId, name, nameKey: name.toLowerCase(), tag, captainId: req.player._id, members: [req.player._id], inviteCode: newInviteCode() });
        } catch (err) {
            if (err.code === 11000 && err.keyPattern?.inviteCode) continue; // retry with a new code
            await CodmPlayer.updateOne({ _id: req.player._id, teamId }, { teamId: null });
            if (err.code === 11000) throw new BadRequestError("That team name is taken. Pick another.");
            throw err;
        }
    }
    if (!team) {
        await CodmPlayer.updateOne({ _id: req.player._id, teamId }, { teamId: null });
        throw new BadRequestError("Could not create the team. Please try again.");
    }
    // Two captains at the same moment could both pass the count check above:
    // re-check by creation order and undo this one if it landed past the limit.
    const earlier = await CodmTeam.countDocuments({ $or: [{ createdAt: { $lt: team.createdAt } }, { createdAt: team.createdAt, _id: { $lt: team._id } }] });
    if (earlier >= cfg.maxTeams) {
        await CodmTeam.deleteOne({ _id: team._id });
        await CodmPlayer.updateOne({ _id: req.player._id, teamId }, { teamId: null });
        throw new BadRequestError("All team slots are taken.");
    }
    res.status(StatusCodes.CREATED).json({ team: await toMyTeamDTO(team) });
};

// POST /api/v1/codm/teams/join  { inviteCode }
const joinTeam = async (req, res) => {
    await assertOpen();
    assertPaid(req.player);
    const code = check.inviteCode((req.body || {}).inviteCode);
    const size = eventConfig().teamSize;
    const team = await CodmTeam.findOne({ inviteCode: code });
    if (!team) throw new NotFoundError("No team has that invite code. Check it with your captain.");
    if (req.player.teamId) throw new BadRequestError("You are already in a team. Leave it first.");
    if (team.members.length >= size) throw new BadRequestError("This team is already full.");

    const claimed = await CodmPlayer.findOneAndUpdate({ _id: req.player._id, teamId: null }, { teamId: team._id }, { new: true });
    if (!claimed) throw new BadRequestError("You are already in a team. Leave it first.");
    // Only adds while there is still room (atomic), so a team can never pass the size limit.
    const updated = await CodmTeam.findOneAndUpdate(
        { _id: team._id, [`members.${size - 1}`]: { $exists: false } },
        { $addToSet: { members: req.player._id } },
        { new: true }
    );
    if (!updated) {
        await CodmPlayer.updateOne({ _id: req.player._id, teamId: team._id }, { teamId: null });
        throw new BadRequestError("This team is already full.");
    }
    res.status(StatusCodes.OK).json({ team: await toMyTeamDTO(updated) });
};

const removeFromTeam = async (team, playerId) => {
    const remaining = team.members.filter((id) => String(id) !== String(playerId));
    await CodmPlayer.updateOne({ _id: playerId, teamId: team._id }, { teamId: null });
    if (remaining.length === 0) {
        await CodmTeam.deleteOne({ _id: team._id });
        return null;
    }
    const update = { $pull: { members: playerId } };
    // The captain left: the longest-standing member takes over.
    if (String(team.captainId) === String(playerId)) update.$set = { captainId: remaining[0] };
    return CodmTeam.findByIdAndUpdate(team._id, update, { new: true });
};

// POST /api/v1/codm/teams/leave
const leaveTeam = async (req, res) => {
    await assertOpen();
    if (!req.player.teamId) throw new BadRequestError("You are not in a team.");
    const team = await CodmTeam.findById(req.player.teamId);
    if (!team) {
        await CodmPlayer.updateOne({ _id: req.player._id }, { teamId: null });
        return res.status(StatusCodes.OK).json({ team: null });
    }
    await removeFromTeam(team, req.player._id);
    clearPublicCache();
    res.status(StatusCodes.OK).json({ team: null });
};

const captainTeam = async (req) => {
    if (!req.player.teamId) throw new BadRequestError("You are not in a team.");
    const team = await CodmTeam.findById(req.player.teamId);
    if (!team) throw new NotFoundError("Team not found.");
    if (String(team.captainId) !== String(req.player._id)) throw new UnauthorizedError("Only the team captain can do that.");
    return team;
};

// PATCH /api/v1/codm/teams/mine  { name?, tag? }  (captain)
const updateMyTeam = async (req, res) => {
    await assertOpen();
    const team = await captainTeam(req);
    const b = req.body || {};
    if (b.name !== undefined) {
        const name = check.teamName(b.name);
        const taken = await CodmTeam.exists({ nameKey: name.toLowerCase(), _id: { $ne: team._id } });
        if (taken) throw new BadRequestError("That team name is taken. Pick another.");
        team.name = name;
        team.nameKey = name.toLowerCase();
    }
    if (b.tag !== undefined) team.tag = check.teamTag(b.tag);
    try {
        await team.save();
    } catch (err) {
        if (err.code === 11000) throw new BadRequestError("That team name is taken. Pick another.");
        throw err;
    }
    res.status(StatusCodes.OK).json({ team: await toMyTeamDTO(team) });
};

// POST /api/v1/codm/teams/mine/invite-code  (captain: old code stops working)
const regenerateInviteCode = async (req, res) => {
    await assertOpen();
    const team = await captainTeam(req);
    team.inviteCode = newInviteCode();
    await team.save();
    res.status(StatusCodes.OK).json({ team: await toMyTeamDTO(team) });
};

// DELETE /api/v1/codm/teams/mine/members/:playerId  (captain)
const removeMember = async (req, res) => {
    await assertOpen();
    const team = await captainTeam(req);
    const playerId = check.objectId(req.params.playerId, "player");
    if (playerId === String(req.player._id)) throw new BadRequestError("Use 'Leave team' to remove yourself.");
    if (!team.members.some((id) => String(id) === playerId)) throw new NotFoundError("That player is not in your team.");
    const updated = await removeFromTeam(team, playerId);
    res.status(StatusCodes.OK).json({ team: updated ? await toMyTeamDTO(updated) : null });
};

module.exports = { getEvent, listTeams, getMyTeam, createTeam, joinTeam, leaveTeam, updateMyTeam, regenerateInviteCode, removeMember };
