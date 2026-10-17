// Deletes a shared User account (Nsoro and GH-GPT) and everything about it:
//   profile + photo, posts + their files, comments (theirs, and all comments on their
//   posts), their stars, their place in everyone's followers/following/saved lists,
//   notifications they sent or got, Nsoro chats (messages both ways, voice notes),
//   moments, encryption device keys, push subscriptions, sign-in tokens, and GH-GPT
//   chats, chat list, images and uploaded files.
// Other people's posts stay; only this user's stars/comments/views come off them.
// Used by DELETE /api/v1/nsoro/me (routes/nsoroRoutes.js). Irreversible.
const mongoose = require('mongoose');
const User = require('../models/User');
const Post = require('../models/Posts');
const Comment = require('../models/Comments');
const Message = require('../models/Message');
const Story = require('../models/Story');
const SocialNotification = require('../models/SocialNotification');
const E2eDevice = require('../models/E2eDevice');
const PushSubscription = require('../models/PushSubscription');
const Token = require('../models/Token');
const Chat = require('../models/ChatAi');
const UserChats = require('../models/UserChatAi');
const GhgptFile = require('../models/GhgptFile');

const deleteFiles = async (ids) => {
    const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'uploads' });
    let deleted = 0;
    for (const id of ids) {
        if (!id || !mongoose.Types.ObjectId.isValid(String(id))) continue;
        try {
            await bucket.delete(new mongoose.Types.ObjectId(String(id)));
            deleted++;
        } catch {
            // already gone
        }
    }
    return deleted;
};

async function deleteUserEverywhere(userId) {
    const id = new mongoose.Types.ObjectId(String(userId));
    const user = await User.findById(id).lean();
    if (!user) return null;
    const files = [];
    const counts = {};

    // Their posts, the files behind them, and every comment on them.
    const posts = await Post.find({ createdBy: id }, 'postId comments').lean();
    const postIds = posts.map((p) => p._id);
    posts.forEach((p) => files.push(p.postId));
    counts.commentsOnTheirPosts = (await Comment.deleteMany({ post: { $in: postIds } })).deletedCount;
    counts.posts = (await Post.deleteMany({ _id: { $in: postIds } })).deletedCount;

    // Their comments on other people's posts.
    const theirComments = await Comment.find({ user: id }, '_id').lean();
    const commentIds = theirComments.map((c) => c._id);
    if (commentIds.length) await Post.updateMany({ comments: { $in: commentIds } }, { $pull: { comments: { $in: commentIds } } });
    counts.comments = (await Comment.deleteMany({ user: id })).deletedCount;

    // Their stars, and their place in other people's lists.
    await Post.updateMany({ likes: id }, { $pull: { likes: id } });
    await User.updateMany({ $or: [{ followers: id }, { following: id }] }, { $pull: { followers: id, following: id } });
    if (postIds.length) await User.updateMany({ saved: { $in: postIds } }, { $pull: { saved: { $in: postIds } } });

    // Notifications they caused or received (and ones about their posts).
    counts.notifications = (await SocialNotification.deleteMany({ $or: [{ recipient: id }, { actor: id }, { post: { $in: postIds } }] })).deletedCount;

    // Nsoro chats: every message to or from them, voice notes included.
    const messages = await Message.find({ $or: [{ sender: id }, { recipient: id }] }, 'audioFileId').lean();
    messages.forEach((m) => m.audioFileId && files.push(m.audioFileId));
    counts.messages = (await Message.deleteMany({ $or: [{ sender: id }, { recipient: id }] })).deletedCount;

    // Moments, and their views on other people's moments.
    const stories = await Story.find({ user: id }, 'fileId').lean();
    stories.forEach((s) => files.push(s.fileId));
    counts.moments = (await Story.deleteMany({ user: id })).deletedCount;
    await Story.updateMany({ viewers: id }, { $pull: { viewers: id } });

    // GH-GPT: chats (and images/attachments in them), the chat list, uploaded files.
    const chats = await Chat.find({ userId: id }).lean();
    chats.forEach((c) => (c.history || []).forEach((h) => {
        if (h.img) files.push(h.img);
        (h.attachments || []).forEach((a) => a.fileId && files.push(a.fileId));
    }));
    counts.ghgptChats = (await Chat.deleteMany({ userId: id })).deletedCount;
    await UserChats.deleteMany({ userId: id });
    const ghFiles = await GhgptFile.find({ userId: id }, 'fileId').lean();
    ghFiles.forEach((f) => files.push(f.fileId));
    counts.ghgptFiles = (await GhgptFile.deleteMany({ userId: id })).deletedCount;

    // Devices and sessions.
    await E2eDevice.deleteMany({ user: id });
    await PushSubscription.deleteMany({ userId: id, realm: 'user' });
    await Token.deleteMany({ user: id });

    // Profile photo, every collected file, then the account itself.
    if (user.profile_picture_id) files.push(user.profile_picture_id);
    counts.files = await deleteFiles(files);
    await User.deleteOne({ _id: id });
    return { username: user.username, ...counts };
}

module.exports = { deleteUserEverywhere };
