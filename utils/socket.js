const jwt = require('jsonwebtoken');
const Message = require('../models/Message');

// userId -> Set of connected socket ids. A Set (not a single id) so a user
// with multiple tabs/devices open gets messages delivered to all of them,
// and so disconnecting one tab can't accidentally clobber another tab's
// still-live entry.
const userSockets = new Map();

const addUserSocket = (userId, socketId) => {
    if (!userSockets.has(userId)) userSockets.set(userId, new Set());
    userSockets.get(userId).add(socketId);
};

const removeUserSocket = (userId, socketId) => {
    const sockets = userSockets.get(userId);
    if (!sockets) return;
    sockets.delete(socketId);
    if (sockets.size === 0) userSockets.delete(userId);
};

const emitToUser = (io, userId, event, payload) => {
    const sockets = userSockets.get(userId);
    if (!sockets) return;
    sockets.forEach((socketId) => io.to(socketId).emit(event, payload));
};

const isUserOnline = (userId) => (userSockets.get(String(userId))?.size || 0) > 0;

// Everything sent to `userId` that hadn't reached a device yet has now reached one
// (they opened the app, or a push landed on their phone): tell each sender, for
// the two grey ticks.
const markDelivered = async (userId) => {
    try {
        const pending = { recipient: userId, deliveredAt: null };
        const senders = await Message.distinct('sender', pending);
        if (!senders.length) return;
        const at = new Date();
        await Message.updateMany(pending, { $set: { deliveredAt: at } });
        senders.forEach((sender) => emitToUserId(String(sender), 'messagesDelivered', { by: String(userId), at }));
    } catch (error) {
        console.warn('markDelivered failed:', error.message);
    }
};

// Set by setupSocket so REST controllers (e.g. utils/socialNotify.js) can push events.
let ioInstance = null;
const emitToUserId = (userId, event, payload) => {
    if (ioInstance) emitToUser(ioInstance, userId, event, payload);
};

const setupSocket = (io) => {
    ioInstance = io;
    // Every connection must carry a valid JWT (the same one issued by
    // POST /api/v1/auth/login) - without this, any client could claim to be
    // any userId via socket.handshake.query and read or send messages as
    // someone else. socket.io-client sends this via `io(url, { auth: {
    // token } })`.
    io.use((socket, next) => {
        const token = socket.handshake.auth?.token || socket.handshake.query?.token;
        if (!token) {
            return next(new Error('Authentication required'));
        }
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            socket.userId = decoded.userId;
            next();
        } catch (error) {
            next(new Error('Invalid or expired token'));
        }
    });

    io.on('connection', (socket) => {
        const userId = socket.userId;
        console.log('\x1b[32m%s\x1b[0m', `User connected: ${userId} (${socket.id})`);
        addUserSocket(userId, socket.id);
        markDelivered(userId);

        // Kept for backwards compatibility with older clients that still
        // call this on connect - the server already knows who you are from
        // the JWT verified above, so this is just an acknowledgement rather
        // than a second identity claim we'd have to trust.
        socket.on('registerUser', () => {
            socket.emit('registered', { userId });
        });

        // sender is always the authenticated socket's own userId - never
        // taken from the client payload, or any connected client could
        // send messages that appear to be from someone else.
        // `ack` is optional: clients that pass a callback get the saved
        // message (with its real _id/timestamp) or an error back.
        socket.on('sendMessage', async ({ recipient, message } = {}, ack) => {
            const reply = typeof ack === 'function' ? ack : () => {};
            if (!recipient || !message) {
                reply({ error: 'recipient and message are required.' });
                return socket.emit('messageError', { error: 'recipient and message are required.' });
            }
            try {
                const newMessage = await Message.create({
                    sender: userId, recipient, message,
                    deliveredAt: isUserOnline(recipient) ? new Date() : null,
                });
                reply({ message: newMessage });
                require('./socialNotify').emailNewMessage(userId, recipient);

                // Deliver to every tab/device the recipient has open, and
                // sync the sender's OTHER sessions too (not this socket -
                // the sending tab already has its own local copy of what
                // it just sent).
                emitToUser(io, recipient, 'receiveMessage', newMessage);
                const senderSockets = userSockets.get(userId);
                if (senderSockets) {
                    senderSockets.forEach((socketId) => {
                        if (socketId !== socket.id) io.to(socketId).emit('receiveMessage', newMessage);
                    });
                }
            } catch (error) {
                console.warn('Error sending message:', error.message);
                reply({ error: 'Failed to send message.' });
                socket.emit('messageError', { error: 'Failed to send message.' });
            }
        });

        // Scoped to the actual recipient only - the previous implementation
        // used socket.broadcast.emit(), which sent every typing event to
        // every connected user regardless of who was actually chatting with
        // whom.
        socket.on('typing', ({ recipient }) => {
            if (!recipient) return;
            emitToUser(io, recipient, 'typing', { sender: userId });
        });

        setupCallEvents(io, socket);

        socket.on('disconnect', () => {
            console.log('\x1b[31m%s\x1b[0m', `User disconnected: ${userId} (${socket.id})`);
            removeUserSocket(userId, socket.id);
            // a dropped tab ends any call it was ringing from or talking on
            calls.forEach((call) => {
                if (call.callerSocket === socket.id || call.calleeSocket === socket.id) finishCall(io, call, 'hangup');
            });
        });

        socket.on('connect_error', (err) => {
            console.error('Connection Error:', err);
        });
    });
};

// ---- Voice / video calls (WebRTC signaling) ----
// The media goes browser-to-browser; this only relays the call invite, the
// answer, and the WebRTC offer/answer/ICE candidates between the two sockets
// that are actually on the call. When a call ends we save a 'call' message so it
// shows up in the chat ("Video call · 2:31", "Missed voice call").
const RING_MS = 35000;
const calls = new Map(); // callId -> { id, caller, callee, kind, callerSocket, calleeSocket, acceptedAt, ringTimer, invite }

// The callee's device has the call (open app, or the push landed): "Ringing…".
const markCallRinging = (callId) => {
    const call = calls.get(callId);
    if (!call || call.acceptedAt || call.ringing || !ioInstance) return;
    call.ringing = true;
    ioInstance.to(call.callerSocket).emit('call:ringing', { callId });
};

const inCall = (userId) => [...calls.values()].some((c) => c.caller === userId || c.callee === userId);

const finishCall = async (io, call, reason) => {
    if (!calls.has(call.id)) return;
    calls.delete(call.id);
    clearTimeout(call.ringTimer);
    [call.caller, call.callee].forEach((u) => emitToUser(io, u, 'call:ended', { callId: call.id, reason }));

    const duration = call.acceptedAt ? Math.round((Date.now() - call.acceptedAt) / 1000) : 0;
    const callStatus = call.acceptedAt ? 'completed' : reason === 'declined' ? 'declined' : 'missed';
    try {
        const log = await Message.create({
            sender: call.caller,
            recipient: call.callee,
            type: 'call',
            callKind: call.kind,
            callStatus,
            duration,
        });
        [call.caller, call.callee].forEach((u) => emitToUser(io, u, 'receiveMessage', log));
        if (callStatus === 'missed') {
            require('./socialNotify').notifyMissedCall({ recipient: call.callee, actor: call.caller, kind: call.kind });
            const { pushToUser } = require('./push');
            const User = require('../models/User');
            const caller = await User.findById(call.caller, 'username').lean();
            pushToUser(call.callee, {
                title: caller?.username || 'Nsoro',
                body: `Missed ${call.kind === 'video' ? 'video' : 'voice'} call`,
                url: `/messages/${call.caller}`,
                tag: `ig-call-${call.id}`,
            }, { app: 'nsoro' });
        }
    } catch (error) {
        console.warn('call log failed:', error.message);
    }
};

const setupCallEvents = (io, socket) => {
    const userId = socket.userId;
    const reply = (ack) => (typeof ack === 'function' ? ack : () => {});

    // A tab that opens while someone is ringing us (e.g. from the push
    // notification) still gets the incoming call.
    calls.forEach((call) => {
        if (call.callee === userId && !call.acceptedAt) socket.emit('call:incoming', call.invite);
    });

    socket.on('call:invite', async ({ to, kind, callId } = {}, ack) => {
        const done = reply(ack);
        if (!to || !callId || String(to) === userId || calls.has(callId)) return done({ error: 'Invalid call.' });
        if (inCall(userId)) return done({ error: 'You are already on a call.' });
        if (inCall(String(to))) return done({ error: 'busy' });

        const User = require('../models/User');
        const caller = await User.findById(userId, 'username firstName lastName profile_picture_id profile_picture').lean();
        const call = {
            id: callId,
            caller: userId,
            callee: String(to),
            kind: kind === 'video' ? 'video' : 'audio',
            callerSocket: socket.id,
            calleeSocket: null,
            acceptedAt: null,
        };
        call.invite = { callId, from: userId, kind: call.kind, caller };
        call.ringTimer = setTimeout(() => finishCall(io, call, 'no-answer'), RING_MS);
        calls.set(callId, call);
        emitToUser(io, call.callee, 'call:incoming', call.invite);
        done({ ok: true });

        const { pushToUser } = require('./push');
        pushToUser(call.callee, {
            title: caller?.username || 'Nsoro',
            body: `Incoming ${call.kind === 'video' ? 'video' : 'voice'} call`,
            url: `/messages/${userId}`,
            tag: `ig-call-${callId}`,
            call: { callId, kind: call.kind }, // the service worker adds Answer / Decline buttons
            urgency: 'high',
            ttl: Math.ceil(RING_MS / 1000), // a phone that was offline must not ring for a call that's over
            ack: require('./pushAck').makeAck({ kind: 'ringing', callId }),
        }, { app: 'nsoro' });
    });

    // the callee's open app got the call
    socket.on('call:ringing', ({ callId } = {}) => {
        const call = calls.get(callId);
        if (call && call.callee === userId) markCallRinging(callId);
    });

    socket.on('call:accept', ({ callId } = {}, ack) => {
        const done = reply(ack);
        const call = calls.get(callId);
        if (!call || call.callee !== userId || call.acceptedAt) return done({ error: 'This call has ended.' });
        clearTimeout(call.ringTimer);
        call.acceptedAt = Date.now();
        call.calleeSocket = socket.id;
        io.to(call.callerSocket).emit('call:accepted', { callId });
        // stop it ringing on the callee's other tabs/devices
        userSockets.get(userId)?.forEach((id) => {
            if (id !== socket.id) io.to(id).emit('call:ended', { callId, reason: 'answered-elsewhere' });
        });
        done({ ok: true });
    });

    socket.on('call:decline', ({ callId } = {}) => {
        const call = calls.get(callId);
        if (call && call.callee === userId && !call.acceptedAt) finishCall(io, call, 'declined');
    });

    socket.on('call:end', ({ callId } = {}) => {
        const call = calls.get(callId);
        if (call && (call.caller === userId || call.callee === userId)) finishCall(io, call, 'hangup');
    });

    // WebRTC offer/answer/ICE candidates, only between the two sockets on the call.
    socket.on('call:signal', ({ callId, data } = {}) => {
        const call = calls.get(callId);
        if (!call || !call.calleeSocket || !data) return;
        const target = socket.id === call.callerSocket ? call.calleeSocket : socket.id === call.calleeSocket ? call.callerSocket : null;
        if (target) io.to(target).emit('call:signal', { callId, data });
    });
};

module.exports = setupSocket;
module.exports.emitToUserId = emitToUserId;
module.exports.isUserOnline = isUserOnline;
module.exports.markDelivered = markDelivered;
module.exports.markCallRinging = markCallRinging;
// Is this call still ringing? (the service worker keeps re-alerting until it isn't)
module.exports.isCallRinging = (callId) => {
    const call = calls.get(callId);
    return Boolean(call && !call.acceptedAt);
};
// "Decline" tapped on the incoming-call notification.
module.exports.declineCallById = (callId) => {
    const call = calls.get(callId);
    if (call && !call.acceptedAt && ioInstance) finishCall(ioInstance, call, 'declined');
};
