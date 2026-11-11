const crypto = require("crypto");
const { StatusCodes } = require("http-status-codes");
const CodmBracket = require("../models/CodmBracket.js");
const CodmTeam = require("../models/CodmTeam.js");
const CodmPlayer = require("../models/CodmPlayer.js");
const { BadRequestError, NotFoundError } = require("../errors");
const { eventConfig, check, cachedPublic, clearPublicCache, PUBLIC_CACHE_MS } = require("../utils/codm.js");

const roundName = (round, totalRounds) => {
    const fromEnd = totalRounds - round;
    if (fromEnd === 1) return "Final";
    if (fromEnd === 2) return "Semi-finals";
    if (fromEnd === 3) return "Quarter-finals";
    return `Round of ${2 ** fromEnd}`;
};

const shuffle = (list) => {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i -= 1) {
        const j = crypto.randomInt(i + 1);
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
};

const findMatch = (bracket, id) => bracket.matches.find((m) => m.id === id);
const nextOf = (m) => ({ id: `r${m.round + 1}m${Math.floor(m.index / 2)}`, slot: m.index % 2 === 0 ? "teamA" : "teamB" });

// Puts the winner of `m` into its slot in the next match (and keeps going while
// that next match is a bye).
const advance = (bracket, m) => {
    const next = findMatch(bracket, nextOf(m).id);
    if (!next) return;
    next[nextOf(m).slot] = m.winner;
};

// A confirmed team: CODM_TEAM_SIZE members, all paid.
const confirmedTeamIds = async () => {
    const size = eventConfig().teamSize;
    const teams = await CodmTeam.find().select("members").lean();
    const paid = new Set((await CodmPlayer.find({ paid: true }).select("_id").lean()).map((p) => String(p._id)));
    return teams.filter((t) => t.members.length === size && t.members.every((id) => paid.has(String(id)))).map((t) => t._id);
};

const toBracketDTO = async (bracket) => {
    if (!bracket) return null;
    const ids = bracket.matches.flatMap((m) => [m.teamA, m.teamB]).filter(Boolean);
    const teams = await CodmTeam.find({ _id: { $in: ids } }).select("name tag").lean();
    const byId = new Map(teams.map((t) => [String(t._id), { id: String(t._id), name: t.name, tag: t.tag }]));
    const team = (id) => (id ? byId.get(String(id)) || { id: String(id), name: "Removed team", tag: null } : null);
    const totalRounds = Math.log2(bracket.size);
    const rounds = Array.from({ length: totalRounds }, (_, r) => ({
        round: r,
        name: roundName(r, totalRounds),
        matches: bracket.matches.filter((m) => m.round === r).sort((a, b) => a.index - b.index).map((m) => ({
            id: m.id,
            round: m.round,
            index: m.index,
            teamA: team(m.teamA),
            teamB: team(m.teamB),
            winner: m.winner ? String(m.winner) : null,
            bye: m.bye,
            startsAt: m.startsAt,
            note: m.note,
            score: m.score,
            ready: !!(m.teamA && m.teamB && !m.winner),
        })),
    }));
    const all = rounds.flatMap((r) => r.matches.map((m) => ({ ...m, roundName: r.name })));
    const upNext = all.filter((m) => m.ready).sort((a, b) => (a.startsAt && b.startsAt ? new Date(a.startsAt) - new Date(b.startsAt) : a.round - b.round || a.index - b.index)).slice(0, 6);
    const final = all.find((m) => m.round === totalRounds - 1);
    return {
        size: bracket.size,
        generatedAt: bracket.generatedAt,
        rounds,
        upNext,
        champion: final?.winner ? team(final.winner) : null,
    };
};

// GET /api/v1/codm/bracket  (public)
const getBracket = async (req, res) => {
    res.set("Cache-Control", `public, max-age=${Math.round(PUBLIC_CACHE_MS / 1000)}, stale-while-revalidate=30`);
    const bracket = await cachedPublic("bracket", PUBLIC_CACHE_MS, async () => toBracketDTO(await CodmBracket.findById("main")));
    res.status(StatusCodes.OK).json({ bracket });
};

// POST /api/v1/codm/admin/bracket/generate  { replace?: true }
// Draws every confirmed team at random into a single-elimination bracket.
// Byes (when the number of teams is not a power of two) are spread out and go
// straight through. Team changes are locked once a bracket exists.
const generateBracket = async (req, res) => {
    const existing = await CodmBracket.findById("main");
    if (existing && (req.body || {}).replace !== true) {
        throw new BadRequestError("A bracket already exists. Reset it first to draw again.");
    }
    const teamIds = shuffle(await confirmedTeamIds());
    const n = teamIds.length;
    if (n < 2) throw new BadRequestError("At least 2 confirmed teams (5 paid players each) are needed to draw the bracket.");
    const size = 2 ** Math.ceil(Math.log2(n));
    const firstRound = size / 2;
    const realMatches = n - firstRound; // matches where two teams play
    // Spread the byes evenly through the first round.
    const byes = firstRound - realMatches;
    const pattern = Array.from({ length: firstRound }, (_, i) => (Math.floor(((i + 1) * byes) / firstRound) > Math.floor((i * byes) / firstRound) ? "bye" : "real"));
    const queue = [...teamIds];
    const matches = [];
    pattern.forEach((kind, index) => {
        const teamA = queue.shift();
        const teamB = kind === "real" ? queue.shift() : null;
        matches.push({ id: `r0m${index}`, round: 0, index, teamA, teamB, bye: kind === "bye", winner: kind === "bye" ? teamA : null });
    });
    for (let r = 1, count = firstRound / 2; count >= 1; r += 1, count /= 2) {
        for (let index = 0; index < count; index += 1) matches.push({ id: `r${r}m${index}`, round: r, index });
    }
    const bracket = existing || new CodmBracket({ _id: "main", size, matches: [] });
    bracket.size = size;
    bracket.matches = matches;
    bracket.generatedAt = new Date();
    bracket.matches.filter((m) => m.bye).forEach((m) => advance(bracket, m));
    await bracket.save();
    clearPublicCache();
    res.status(StatusCodes.CREATED).json({ bracket: await toBracketDTO(bracket) });
};

// PATCH /api/v1/codm/admin/bracket/matches/:matchId
//   { winnerTeamId?: id | null, startsAt?: ISO | null, note?: string | null, score?: string | null }
const updateMatch = async (req, res) => {
    const bracket = await CodmBracket.findById("main");
    if (!bracket) throw new NotFoundError("No bracket yet.");
    const matchId = String(req.params.matchId || "");
    if (!/^r\d{1,2}m\d{1,3}$/.test(matchId)) throw new BadRequestError("Invalid match");
    const m = findMatch(bracket, matchId);
    if (!m) throw new NotFoundError("Match not found");
    const b = req.body || {};

    if (b.startsAt !== undefined) {
        if (b.startsAt === null || b.startsAt === "") m.startsAt = null;
        else {
            const d = new Date(typeof b.startsAt === "string" ? b.startsAt : NaN);
            if (Number.isNaN(d.getTime())) throw new BadRequestError("Invalid match time");
            m.startsAt = d;
        }
    }
    if (b.note !== undefined) m.note = check.text(b.note, "Note", { max: 80, optional: true });
    if (b.score !== undefined) m.score = check.text(b.score, "Score", { max: 20, optional: true, pattern: /^[0-9A-Za-z :\-–]+$/, patternMsg: "Score like 2-1" });

    if (b.winnerTeamId !== undefined) {
        if (m.bye) throw new BadRequestError("This team had a bye; there is no match to decide.");
        const next = findMatch(bracket, nextOf(m).id);
        if (next && next.winner) throw new BadRequestError("The next round is already decided. Undo that result first.");
        if (b.winnerTeamId === null) {
            m.winner = null;
            m.score = b.score === undefined ? null : m.score;
            if (next) next[nextOf(m).slot] = null;
        } else {
            const winner = check.objectId(b.winnerTeamId, "team");
            if (!m.teamA || !m.teamB) throw new BadRequestError("Both teams must be known before a result is entered.");
            if (winner !== String(m.teamA) && winner !== String(m.teamB)) throw new BadRequestError("The winner must be one of the two teams in this match.");
            m.winner = winner;
            advance(bracket, m);
        }
    }
    bracket.markModified("matches");
    await bracket.save();
    clearPublicCache();
    res.status(StatusCodes.OK).json({ bracket: await toBracketDTO(bracket) });
};

// DELETE /api/v1/codm/admin/bracket  { confirm: "RESET" }
const resetBracket = async (req, res) => {
    if ((req.body || {}).confirm !== "RESET") throw new BadRequestError('Send { "confirm": "RESET" } to delete the bracket.');
    await CodmBracket.deleteOne({ _id: "main" });
    clearPublicCache();
    res.status(StatusCodes.OK).json({ bracket: null });
};

const bracketExists = () => CodmBracket.exists({ _id: "main" });

module.exports = { getBracket, generateBracket, updateMatch, resetBracket, bracketExists };
