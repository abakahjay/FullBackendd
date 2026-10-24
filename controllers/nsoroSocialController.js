const mongoose = require('mongoose');
const { StatusCodes } = require('http-status-codes');
const Post = require('../models/Posts');
const User = require('../models/User');
const Comment = require('../models/Comments');
const NsoroReport = require('../models/NsoroReport');
const { BadRequestError, NotFoundError, UnauthenticatedError } = require('../errors');
const posts = require('./postController');
const users = require('./userController');
const comments = require('./commentController');

// Logged-in versions of Nsoro's social actions, under /api/v1/nsoro.
//
// The original routes (/api/v1/posts, /users/:id/follow, /comments...) trust a userId
// sent by the browser, so anyone can act as anyone. They are still used unchanged by
// other apps on this backend (GHGPT's Chatbot), so they are left exactly as they are.
// These routes take the user from the JWT (authMiddleware -> req.user.userId), check
// ownership where it matters, then reuse the original handlers so behaviour matches.

const me = (req) => req.user.userId;
const validId = (id, what) => {
    if (!mongoose.Types.ObjectId.isValid(id)) throw new BadRequestError(`Invalid ${what} id`);
};

// POST /nsoro/posts (multipart "file" + caption) - you are the author.
exports.createPost = (req, res) => {
    req.query.userId = me(req);
    return posts.createPost(req, res);
};

const isAdmin = async (req) => (await User.findById(me(req), { role: 1 }))?.role === 'admin';

// DELETE /nsoro/posts/:postId - the author, or an admin taking down reported content.
exports.deletePost = async (req, res) => {
    validId(req.params.postId, 'post');
    const post = await Post.findById(req.params.postId, { postId: 1, createdBy: 1 });
    if (!post) throw new NotFoundError('Post not found');
    const own = String(post.createdBy) === me(req);
    if (!own && !(await isAdmin(req))) throw new UnauthenticatedError('You can only delete your own posts');
    if (!own) {
        await NsoroReport.updateMany({ post: post._id, status: 'open' },
            { status: 'removed', resolvedBy: me(req), resolvedAt: new Date() });
    }
    req.params.fileId = String(post.postId);
    req.query.userId = String(post.createdBy); // the owner's profile loses the post
    return posts.deletePost(req, res);
};

// POST /nsoro/posts/:postId/report { reason, details? } - flag a post for the admins
// (copyright takedowns, nudity, harassment...). One open report per user per post.
exports.reportPost = async (req, res) => {
    validId(req.params.postId, 'post');
    const reason = String(req.body?.reason || '');
    if (!NsoroReport.REASONS.includes(reason)) {
        throw new BadRequestError(`reason must be one of: ${NsoroReport.REASONS.join(', ')}`);
    }
    const details = typeof req.body?.details === 'string' ? req.body.details.trim().slice(0, 1000) : '';
    if (reason === 'copyright' && details.length < 10) {
        throw new BadRequestError('For a copyright report, describe the work you own and how to contact you');
    }
    const post = await Post.findById(req.params.postId, { createdBy: 1 });
    if (!post) throw new NotFoundError('Post not found');
    await NsoroReport.findOneAndUpdate(
        { post: post._id, reportedBy: me(req), status: 'open' },
        { reason, details, postOwner: post.createdBy },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    res.status(StatusCodes.CREATED).json({ ok: true, message: 'Thanks. Our team will review this post.' });
};

// GET /nsoro/reports?status=open - admins only (adminOnly middleware).
exports.listReports = async (req, res) => {
    const status = ['open', 'removed', 'dismissed'].includes(req.query.status) ? req.query.status : 'open';
    const reports = await NsoroReport.find({ status }).sort({ createdAt: -1 }).limit(200)
        .populate('reportedBy', 'username')
        .populate('postOwner', 'username')
        .populate('post', 'postId caption mediaType created')
        .lean();
    // How many of the owner's posts were already removed after reports: repeat infringers.
    const owners = [...new Set(reports.map((r) => String(r.postOwner?._id || '')).filter(Boolean))];
    const removed = await NsoroReport.aggregate([
        { $match: { status: 'removed', postOwner: { $in: owners.map((o) => new mongoose.Types.ObjectId(o)) } } },
        { $group: { _id: '$postOwner', posts: { $addToSet: '$post' } } },
    ]);
    const strikes = Object.fromEntries(removed.map((r) => [String(r._id), r.posts.length]));
    res.json({ reports: reports.map((r) => ({ ...r, ownerRemovedPosts: strikes[String(r.postOwner?._id)] || 0 })) });
};

// PATCH /nsoro/reports/:reportId { status: "dismissed" } - admins only. Removing the
// post goes through DELETE /nsoro/posts/:postId, which closes its open reports.
exports.resolveReport = async (req, res) => {
    validId(req.params.reportId, 'report');
    if (req.body?.status !== 'dismissed') throw new BadRequestError('status must be "dismissed"');
    const report = await NsoroReport.findById(req.params.reportId);
    if (!report) throw new NotFoundError('Report not found');
    await NsoroReport.updateMany({ post: report.post, status: 'open' },
        { status: 'dismissed', resolvedBy: me(req), resolvedAt: new Date() });
    res.json({ ok: true });
};

// PATCH /nsoro/posts/:postId/like | /unlike - as yourself.
exports.likePost = (req, res) => {
    req.body = { ...req.body, userId: me(req) };
    return posts.likePosts(req, res);
};
exports.unlikePost = (req, res) => {
    req.body = { ...req.body, userId: me(req) };
    return posts.unlikePosts(req, res);
};

// POST /nsoro/posts/:postId/comments { text } - as yourself.
exports.addComment = (req, res) => {
    req.body = { text: req.body.text, userId: me(req) };
    return comments.addComment(req, res);
};

// DELETE /nsoro/comments/:commentId - the commenter or the post's author.
exports.deleteComment = async (req, res) => {
    validId(req.params.commentId, 'comment');
    const comment = await Comment.findById(req.params.commentId);
    if (!comment) throw new NotFoundError('Comment not found');
    const post = await Post.findById(comment.post, { createdBy: 1 });
    const allowed = String(comment.user) === me(req) || (post && String(post.createdBy) === me(req));
    if (!allowed) throw new UnauthenticatedError('You can only delete your own comments');
    await Comment.deleteOne({ _id: comment._id });
    await Post.updateOne({ _id: comment.post }, { $pull: { comments: comment._id } });
    res.status(StatusCodes.OK).json({ deleted: true, _id: comment._id });
};

// PATCH /nsoro/users/:targetId/follow | /unfollow - you follow them.
exports.follow = (req, res) => {
    validId(req.params.targetId, 'user');
    if (req.params.targetId === me(req)) throw new BadRequestError("You can't follow yourself");
    req.body = { userId: req.params.targetId };
    req.params.id = me(req);
    return users.followUser(req, res);
};
exports.unfollow = (req, res) => {
    validId(req.params.targetId, 'user');
    req.body = { userId: req.params.targetId };
    req.params.id = me(req);
    return users.unfollowUser(req, res);
};

// PATCH /nsoro/me { firstName, lastName, username, bio } - your own profile only.
const PUBLIC_FIELDS = '-password -tokens -resetPasswordToken -resetPasswordExpires';
exports.updateMe = async (req, res) => {
    const update = {};
    for (const key of ['firstName', 'lastName', 'username', 'bio']) {
        if (typeof req.body[key] === 'string' && req.body[key].trim()) update[key] = req.body[key].trim();
    }
    if (update.username && !/^[a-zA-Z0-9._]{3,30}$/.test(update.username)) {
        throw new BadRequestError('Usernames can use letters, numbers, . and _ (3-30 characters)');
    }
    const user = await User.findByIdAndUpdate(me(req), update, { new: true, runValidators: true }).select(PUBLIC_FIELDS);
    res.status(StatusCodes.OK).json({ user });
};

// PATCH /nsoro/me/photo (multipart "photo") - your own profile picture.
exports.updateMyPhoto = async (req, res) => {
    if (!req.file) throw new BadRequestError('Please choose a photo');
    const user = await User.findById(me(req));
    const old = user.profile_picture_id;
    user.profile_picture_id = req.file.id;
    await user.save();
    if (old) {
        await new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'uploads' }).delete(old).catch(() => {});
    }
    const fresh = await User.findById(me(req)).select(PUBLIC_FIELDS);
    res.status(StatusCodes.OK).json({ user: fresh });
};
