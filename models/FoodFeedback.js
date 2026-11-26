const mongoose = require("mongoose");

const feedbackSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
        orderId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "FoodOrders", // your order model name
            required: true,
        },
        eaten: {
            type: String,
            enum: ["yes", "no","Yes", "No"],
            required: true,
        },
        delivered: {
            type: String,
            enum: ["yes", "no","Yes", "No"],
            required: true,
        },
        comment: {
            type: String,
            default: "",
        },
    },
    { timestamps: true }
);

// Indexes for the fields this collection is queried/sorted by (production audit).
feedbackSchema.index({ orderId: 1 });
feedbackSchema.index({ userId: 1, createdAt: -1 });
module.exports = mongoose.model("FoodFeedback", feedbackSchema);
