// Nsoro's ranked feed (GET /api/v1/nsoro/feed). Everyone sees every post - nobody
// gets an empty feed - but in an order made for them, the way big social apps do it:
//   freshness   newer posts first (a score that halves about every day and a half)
//   engagement  stars and comments (comments count double), on a log scale
//   affinity    people you follow, and people whose posts you star or comment on
//   yours       your own post from the last hour goes to the top
//   variety     a small per-person-per-day shuffle, so the feed doesn't feel frozen
//   spread      never the same poster twice in a row when there's an alternative
const mongoose = require('mongoose');
const Post = require('../models/Posts');
const Comment = require('../models/Comments');
const User = require('../models/User');

const MAX_CANDIDATES = 400;
const HOUR = 3600 * 1000;

// Deterministic 0..1 from a string (same person + post + day = same jitter).
const jitter = (key) => {
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
    return ((h >>> 0) % 1000) / 1000;
};

async function rankedFeed(userId, { kind } = {}) {
    const me = new mongoose.Types.ObjectId(userId);
    const filter = kind === 'video' ? { mediaType: 'video' } : {};
    const [posts, user, myComments, myLikes] = await Promise.all([
        Post.find(filter).sort('-created').limit(MAX_CANDIDATES).populate('comments').lean(),
        User.findById(me, 'following').lean(),
        Comment.find({ user: me }, 'post').lean(),
        Post.find({ likes: me }, 'createdBy').lean(),
    ]);
    const following = new Set((user?.following || []).map(String));

    // How much you engage with each author.
    const affinity = new Map();
    const bump = (author, by) => author && affinity.set(String(author), (affinity.get(String(author)) || 0) + by);
    myLikes.forEach((p) => bump(p.createdBy, 1));
    if (myComments.length) {
        const commented = await Post.find({ _id: { $in: myComments.map((c) => c.post) } }, 'createdBy').lean();
        commented.forEach((p) => bump(p.createdBy, 2));
    }

    const now = Date.now();
    const day = new Date().toISOString().slice(0, 10);
    const scored = posts.map((post) => {
        const author = String(post.createdBy);
        const at = Number(post.created) || new Date(post.createdAt).getTime() || now;
        const ageHours = Math.max(0, (now - at) / HOUR);
        const freshness = Math.pow(0.5, ageHours / 36);
        const engagement = Math.log1p((post.likes?.length || 0) + 2 * (post.comments?.length || 0));
        let score = freshness * 10 + engagement;
        if (following.has(author)) score *= 1.6;
        score *= 1 + 0.25 * Math.log1p(affinity.get(author) || 0);
        score *= 0.9 + 0.2 * jitter(`${userId}:${post._id}:${day}`);
        if (author === String(me) && ageHours < 1) score += 1000; // you just posted it
        return { post, author, score };
    });
    scored.sort((a, b) => b.score - a.score);

    // Spread posters out: take the best post whose author differs from the last one.
    const ordered = [];
    const rest = [...scored];
    while (rest.length) {
        const last = ordered[ordered.length - 1]?.author;
        const i = rest.findIndex((x) => x.author !== last);
        ordered.push(...rest.splice(i === -1 ? 0 : i, 1));
    }
    return ordered.map((x) => x.post);
}

module.exports = { rankedFeed };
