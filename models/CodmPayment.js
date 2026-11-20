const mongoose = require("mongoose");

// One row per Paystack checkout started for a CODM entry fee. The amount is
// fixed by the server when the checkout starts and checked again against
// Paystack before the player is marked paid (verify call or webhook).
const CodmPaymentSchema = new mongoose.Schema(
    {
        reference: { type: String, required: true, unique: true },
        playerId: { type: mongoose.Schema.Types.ObjectId, ref: "CodmPlayer", required: true, index: true },
        amountPesewas: { type: Number, required: true },
        currency: { type: String, default: "GHS" },
        status: { type: String, enum: ["pending", "success", "failed"], default: "pending" },
        channel: { type: String, default: null },
        paidAt: { type: Date, default: null },
        // Refunds (controllers/codmRefunds.js). null = not refunded. "requesting" is a
        // short-lived claim while we call Paystack; then Paystack's own status
        // (pending, processing, processed, needs-attention), "failed" when Paystack refused
        // (refundError says why; it can be retried), or "manual" for cash refunded by hand.
        refundStatus: { type: String, enum: [null, "requesting", "pending", "processing", "processed", "needs-attention", "failed", "manual"], default: null, index: true },
        refundId: { type: Number, default: null },
        refundAmountPesewas: { type: Number, default: null },
        refundError: { type: String, default: null },
        refundRequestedAt: { type: Date, default: null },
        refundRequestedBy: { type: String, default: null },
        refundUpdatedAt: { type: Date, default: null },
    },
    { timestamps: true }
);

module.exports = mongoose.model("CodmPayment", CodmPaymentSchema);
