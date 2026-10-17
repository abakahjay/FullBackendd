const SocialNotification = require('../models/SocialNotification');
const { emitToUserId, isUserOnline } = require('./socket');
const User = require('../models/User');
const { sendNsoroEmail, siteUrl } = require('./nsoroMail');
const { pushToUser } = require('./push');
const { makeAck } = require('./pushAck');

// profile_picture is the Google photo URL for Google sign-in accounts
const ACTOR_FIELDS = 'username firstName lastName profile_picture_id profile_picture';

// Records a notification and pushes it to the recipient's open tabs over socket.io.
// Never throws: a failed notification must not fail the like/comment/follow itself.
async function notify({ recipient, actor, type, post, text }) {
    try {
        if (!recipient || !actor || String(recipient) === String(actor)) return; // no self-notifications
        // One like/follow notification per actor+target, so like/unlike spam doesn't pile up.
        if (type !== 'comment') {
            await SocialNotification.deleteMany({ recipient, actor, type, ...(post ? { post } : {}) });
        }
        const created = await SocialNotification.create({ recipient, actor, type, post, text: (text || '').slice(0, 140) });
        const full = await SocialNotification.findById(created._id)
            .populate('actor', ACTOR_FIELDS)
            .populate('post', 'postId mediaType');
        emitToUserId(String(recipient), 'notification', full);
        pushActivity(full);
        if (type !== 'like') emailActivity(full); // likes stay in-app only - too frequent for email
    } catch (err) {
        console.warn('notify failed:', err.message);
    }
}

// Device notification for every activity, likes included (the app suppresses it when open).
function pushActivity(n) {
    const who = n.actor?.username || 'Someone';
    const text = n.type === 'like' ? `${who} starred your post`
        : n.type === 'follow' ? `${who} started following you`
        : `${who} commented: ${n.text || ''}`;
    pushToUser(n.recipient, {
        title: 'Nsoro',
        body: text,
        url: n.type === 'follow' ? `/${encodeURIComponent(who.trim())}` : '/notifications',
        tag: `ig-${n.type}-${n.post?._id || who}`,
    }, { app: 'nsoro' });
}

// Fire-and-forget: email must never slow down or fail the action itself.
function emailActivity(n) {
    (async () => {
        const recipient = await User.findById(n.recipient, 'email emailNotifications username firstName');
        const who = (n.actor?.username || 'Someone').trim();
        const email = n.type === 'follow'
            ? { title: `${who} started following you on Nsoro`, message: `${who} started following you on Nsoro. You can see their profile and follow them back.`, cta: { label: `See ${who}'s profile`, url: siteUrl(`/${encodeURIComponent(who)}`) } }
            : { title: `${who} commented on your post on Nsoro`, message: `${who} left a comment on your post:

"${n.text}"`, cta: { label: 'See the comment', url: siteUrl(`/p/${n.post?._id || ''}`) } };
        await sendNsoroEmail(recipient, { ...email, kind: n.type, throttle: true, push: false });
    })().catch((err) => console.warn('activity email failed:', err.message));
}

// "You have new messages": a device notification for every message (the app hides it
// while it's open), plus an email only when the recipient isn't connected right now.
function emailNewMessage(senderId, recipientId) {
    User.findById(senderId, 'username').lean().then((sender) => pushToUser(recipientId, {
        title: sender?.username || 'New message',
        body: 'Sent you a message',
        url: `/messages/${senderId}`,
        tag: `ig-msg-${senderId}`,
        ack: makeAck({ kind: 'delivered', userId: String(recipientId) }),
    }, { app: 'nsoro' })).catch(() => {});
    if (isUserOnline(recipientId)) return;
    (async () => {
        const [sender, recipient] = await Promise.all([
            User.findById(senderId, 'username'),
            User.findById(recipientId, 'email emailNotifications username firstName'),
        ]);
        await sendNsoroEmail(recipient, {
            title: `${sender?.username?.trim() || 'Someone'} sent you a message on Nsoro`,
            message: `${sender?.username?.trim() || 'Someone'} sent you a message on Nsoro while you were away.`,
            cta: { label: 'Read the message', url: siteUrl(`/messages/${senderId}`) },
            kind: `message:${senderId}`,
            throttle: true,
            push: false,
        });
    })().catch((err) => console.warn('message email failed:', err.message));
}

// A call the recipient didn't answer shows in their Notifications list (in-app only:
// the missed-call push is sent by utils/socket.js, and calls never send email).
async function notifyMissedCall({ recipient, actor, kind }) {
    try {
        const created = await SocialNotification.create({ recipient, actor, type: 'call', text: kind === 'video' ? 'video' : 'audio' });
        const full = await SocialNotification.findById(created._id).populate('actor', ACTOR_FIELDS);
        emitToUserId(String(recipient), 'notification', full);
    } catch (err) {
        console.warn('call notification failed:', err.message);
    }
}

// Undo a like/follow notification when the action is reversed.
async function unnotify({ recipient, actor, type, post }) {
    try {
        await SocialNotification.deleteMany({ recipient, actor, type, ...(post ? { post } : {}) });
    } catch (err) {
        console.warn('unnotify failed:', err.message);
    }
}

module.exports = { notify, unnotify, emailNewMessage, notifyMissedCall, ACTOR_FIELDS };
