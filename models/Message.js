const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
    sender: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: [true, 'Please Provide the Sender UserId']
    },
    recipient: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: [true, 'Please Provide the Receiver UserId']
    },
    // 'voice' messages carry an audio file (GridFS `uploads`, served by
    // /api/v1/posts/media/:audioFileId) instead of text.
    // 'call' messages are the voice/video call log written by utils/socket.js
    // (sender = whoever started the call).
    type: { type: String, enum: ['text', 'voice', 'call'], default: 'text' },
    message: {
        type: String,
        required: [function () { return this.type === 'text' && !this.e2e; }, 'Please Provide the Message'],
        default: ''
    },
    // End-to-end encrypted envelope (utils/e2e.js). When set, `message` is empty and
    // only the two people's devices can read the text (or, for voice notes, the
    // audio file, which is stored encrypted).
    e2e: { type: mongoose.Schema.Types.Mixed, default: undefined },
    audioFileId: { type: mongoose.Schema.Types.ObjectId },
    duration: { type: Number, default: 0 }, // seconds, voice notes and calls
    callKind: { type: String, enum: ['audio', 'video'] }, // calls only
    callStatus: { type: String, enum: ['completed', 'missed', 'declined'] }, // calls only
    editedAt: { type: Date, default: null }, // set when the sender edits the text
    // When it reached the recipient's device (open app, or a push notification
    // while the app was closed): two grey ticks. `read` makes them blue.
    deliveredAt: { type: Date, default: null },
    read: {
        type: Boolean,
        default: false
    },
    timestamp: {
        type: Date,
        // Function, not Date.now() - that would stamp every message with the server start time.
        default: Date.now
    },
});

MessageSchema.index({ sender: 1, recipient: 1, timestamp: -1 });
MessageSchema.index({ recipient: 1, sender: 1, timestamp: -1 });

const Message = mongoose.model('Message', MessageSchema);
module.exports = Message;
