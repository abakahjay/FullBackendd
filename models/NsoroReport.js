const mongoose = require('mongoose');

// A user's report of an Nsoro post (copyright, nudity, harassment...). Admins review
// open reports and either remove the post or dismiss the report. Kept after the post
// is removed so repeat infringers can be found.
const REASONS = ['copyright', 'nudity', 'harassment', 'violence', 'spam', 'other'];

const NsoroReportSchema = new mongoose.Schema({
    post: { type: mongoose.Schema.Types.ObjectId, ref: 'Posts', required: true, index: true },
    postOwner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, enum: REASONS, required: true },
    details: { type: String, maxlength: 1000, default: '' },
    status: { type: String, enum: ['open', 'removed', 'dismissed'], default: 'open', index: true },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedAt: { type: Date, default: null },
}, { timestamps: true });

// One open report per user per post; reporting again just updates it.
NsoroReportSchema.index({ post: 1, reportedBy: 1 });

module.exports = mongoose.model('NsoroReport', NsoroReportSchema);
module.exports.REASONS = REASONS;
