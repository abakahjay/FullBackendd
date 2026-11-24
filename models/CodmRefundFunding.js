const mongoose = require("mongoose");

// An organiser paying money back into Paystack (MoMo prompt on their phone) so a
// refund can go out when Paystack has no unpaid-out money left to take it from.
// One row per attempt; the player's refund runs once, when the charge succeeds.
const CodmRefundFundingSchema = new mongoose.Schema(
    {
        reference: { type: String, required: true, unique: true },
        // "one": fund one player's refund. "all": fund cancel-and-refund-everyone.
        kind: { type: String, enum: ["one", "all"], default: "one" },
        paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "CodmPayment", default: null, index: true },
        playerId: { type: mongoose.Schema.Types.ObjectId, ref: "CodmPlayer", default: null },
        reason: { type: String, default: null }, // "all": the cancellation reason players will see
        amountPesewas: { type: Number, required: true },
        phone: { type: String, required: true },
        adminEmail: { type: String, required: true },
        status: { type: String, enum: ["pending", "success", "failed"], default: "pending" },
        message: { type: String, default: null },
        refundStarted: { type: Boolean, default: false }, // claimed atomically so the refund runs once
        refundResult: { type: String, default: null },
    },
    { timestamps: true }
);

module.exports = mongoose.model("CodmRefundFunding", CodmRefundFundingSchema);
