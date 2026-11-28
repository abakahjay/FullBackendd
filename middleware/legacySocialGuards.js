// Guards for the original social routes (/api/v1/posts, /comments, /users, /userse)
// that GH-GPT still calls. They used to trust the user id or username sent by the
// client, with no login: anyone could post, like, comment or follow as anyone, delete
// any post or comment, and change anyone's email (then reset the password: account
// takeover). Each guard runs after authMiddleware and either takes the acting user
// from the token or checks ownership, then hands over to the original handler, so
// response shapes stay the same. Nsoro uses the /api/v1/nsoro versions instead.
const mongoose = require('mongoose');
const Post = require('../models/Posts');
const Comment = require('../models/Comments');
const { BadRequestError, NotFoundError } = require('../errors');
const { isAdmin } = require('./auth');

const me = (req) => String(req.user.userId);

// POST /posts?userId= : the post is created as the signed-in user.
const asSelfQuery = (req, res, next) => {
    req.query.userId = me(req);
    next();
};

// PATCH /posts/:postId/like|unlike, POST /comments/:postId { userId }: as yourself.
const asSelfBody = (req, res, next) => {
    req.body = { ...(req.body || {}), userId: me(req) };
    next();
};

// /users/:username/editUser, /userse/:username/editUserProfile: your own profile only.
const selfUsername = (req, res, next) => {
    if (String(req.params.username) !== String(req.user.username)) throw new NotFoundError('Not found');
    next();
};

// DELETE /posts/image/:fileId : the post's author or an admin. The handler reads the
// owner from ?userId, so it's set from the post, never from the client.
const ownPostFile = async (req, res, next) => {
    const { fileId } = req.params;
    if (!mongoose.isValidObjectId(fileId)) throw new BadRequestError('Invalid post id');
    const post = await Post.findOne({ postId: fileId }, { createdBy: 1 });
    if (!post) throw new NotFoundError('Post not found');
    if (String(post.createdBy) !== me(req) && !isAdmin(req)) throw new NotFoundError('Post not found');
    req.query.userId = String(post.createdBy);
    next();
};

// DELETE /comments/:postId?commentId= : the commenter, the post's author or an admin.
const ownComment = async (req, res, next) => {
    const { commentId } = req.query;
    if (!mongoose.isValidObjectId(commentId)) throw new BadRequestError('Invalid comment id');
    const comment = await Comment.findById(commentId, { user: 1, post: 1 });
    if (!comment) throw new NotFoundError('Comment not found');
    const post = comment.post ? await Post.findById(comment.post, { createdBy: 1 }) : null;
    const allowed = String(comment.user) === me(req) || (post && String(post.createdBy) === me(req)) || isAdmin(req);
    if (!allowed) throw new NotFoundError('Comment not found');
    next();
};

module.exports = { asSelfQuery, asSelfBody, selfUsername, ownPostFile, ownComment };
