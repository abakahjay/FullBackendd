const express = require('express');
const rateLimit = require('express-rate-limit');
const authMiddleware = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const { unsubscribePage, unsubscribe, setEmailPreference, sendUpdate, authEvent } = require('../controllers/nsoroController');
const social = require('../controllers/nsoroSocialController');

const router = express.Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

router.get('/email/unsubscribe', limiter, unsubscribePage);
router.post('/email/unsubscribe', limiter, unsubscribe);
router.patch('/settings/email', authMiddleware, setEmailPreference);
router.post('/events', authMiddleware, authEvent); // welcome / new-sign-in emails
router.post('/updates', authMiddleware, adminOnly, sendUpdate);

// Logged-in social actions (the user comes from the token, never the request body).
// Uploads (POST /posts, PATCH /me/photo) live in routes/nsoroUploadRoutes.js.
router.delete('/posts/:postId', authMiddleware, social.deletePost);
router.patch('/posts/:postId/like', authMiddleware, social.likePost);
router.patch('/posts/:postId/unlike', authMiddleware, social.unlikePost);
router.post('/posts/:postId/comments', authMiddleware, social.addComment);
router.delete('/comments/:commentId', authMiddleware, social.deleteComment);
router.patch('/users/:targetId/follow', authMiddleware, social.follow);
router.patch('/users/:targetId/unfollow', authMiddleware, social.unfollow);
router.patch('/me', authMiddleware, social.updateMe);

// Delete my account and everything about it (utils/deleteAccount.js), Nsoro and GH-GPT.
// The body must repeat the username: { confirm: "<username>" }.
router.delete('/me', authMiddleware, limiter, async (req, res) => {
    const User = require('../models/User');
    const me = await User.findById(req.user.userId, 'username').lean();
    if (!me) return res.status(404).json({ error: 'Account not found.' });
    const typed = String(req.body?.confirm || '').trim().toLowerCase();
    if (!typed || typed !== String(me.username).trim().toLowerCase()) {
        return res.status(400).json({ error: 'Type your username exactly to confirm.' });
    }
    const result = await require('../utils/deleteAccount').deleteUserEverywhere(req.user.userId);
    console.log('Account deleted:', JSON.stringify(result));
    res.json({ deleted: true });
});

// Ranked feed for the signed-in user (utils/nsoroFeed.js); ?kind=video for the Watch page.
router.get('/feed', authMiddleware, async (req, res) => {
    const posts = await require('../utils/nsoroFeed').rankedFeed(req.user.userId, { kind: req.query.kind });
    res.json({ nbHits: posts.length, posts });
});

module.exports = router;
