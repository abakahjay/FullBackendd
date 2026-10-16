const mongoose = require("mongoose");
const { nextSequence } = require("../utils/cleanbridge.js");
const { WASTE_TYPES } = require("../utils/ghana.js");

// A recurring collection plan (weekly or monthly). It books each visit as an
// ordinary CleanBridgePickup a couple of days ahead (utils/cleanbridgePlans.js),
// so collectors, payments and tracking work exactly as for one-off pickups.
const CleanBridgeSubscriptionSchema = new mongoose.Schema(
    {
        code: { type: String, unique: true, index: true }, // e.g. "PL-0042"
        customerId: { type: mongoose.Schema.Types.ObjectId, ref: "CleanBridgeUser", required: true, index: true },
        customerName: { type: String, required: true },
        customerPhone: { type: String, default: null },
        frequency: { type: String, enum: ["weekly", "monthly"], required: true },
        // weekly: 0 (Sun) - 6 (Sat); monthly: 1 - 28 (so every month has the day).
        dayOfWeek: { type: Number, min: 0, max: 6, default: null },
        dayOfMonth: { type: Number, min: 1, max: 28, default: null },
        area: { type: String, required: true },
        address: { type: String, required: true },
        region: { type: String, default: null },
        ghanaPostGps: { type: String, default: null },
        gateNote: { type: String, default: null },
        location: {
            lat: { type: Number, required: true },
            lng: { type: Number, required: true },
        },
        hubId: { type: String, default: null },
        hubName: { type: String, default: null },
        wasteType: { type: String, enum: WASTE_TYPES, required: true },
        bags: { type: Number, required: true, min: 1, max: 50 },
        vehicleType: { type: String, default: null },
        timeWindow: { type: String, required: true },
        floors: { type: Number, default: 0, min: 0, max: 30 },
        binWash: { type: Boolean, default: false },
        paymentMethod: { type: String, enum: ["cash", "momo"], default: "cash" },
        // Last quoted price per visit (each visit is re-priced when it is booked).
        pricePerVisit: { type: Number, default: 0 },
        discountPct: { type: Number, default: 0 },
        status: { type: String, enum: ["active", "paused", "cancelled"], default: "active", index: true },
        startDate: { type: Date, required: true },
        // Date of the next visit that has not been booked yet.
        nextDate: { type: Date, required: true, index: true },
        visitsBooked: { type: Number, default: 0 },
        lastPickupId: { type: mongoose.Schema.Types.ObjectId, ref: "CleanBridgePickup", default: null },
        cancelledAt: { type: Date, default: null },
    },
    { timestamps: true }
);

CleanBridgeSubscriptionSchema.pre("save", async function (next) {
    if (!this.code) {
        const seq = await nextSequence("plan");
        this.code = `PL-${String(seq).padStart(4, "0")}`;
    }
    next();
});

module.exports = mongoose.model("CleanBridgeSubscription", CleanBridgeSubscriptionSchema);
