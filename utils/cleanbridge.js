const mongoose = require("mongoose");
const { detectNetwork } = require("./ghana.js");

// Shared helpers for the CleanBridge GH app (/api/v1/cleanbridge/*).

// =========================
// Atomic sequence for human-friendly codes (CB-1001, RT-0001)
// =========================
const CounterSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    seq: { type: Number, default: 0 },
});
const Counter = mongoose.models.CleanBridgeCounter
    || mongoose.model("CleanBridgeCounter", CounterSchema);

const nextSequence = async (name) => {
    const counter = await Counter.findOneAndUpdate(
        { _id: name },
        { $inc: { seq: 1 } },
        { new: true, upsert: true }
    );
    return counter.seq;
};

// =========================
// Pricing (GH₵)
// =========================
const round2 = (n) => Math.round(n * 100) / 100;

// Returns the itemised quote so the frontend can show the breakdown.
// `distanceKm` must come from serviceInfo() (server-side), never the client.
const TAX_LINES = [
    ["nhil", "NHIL", "nhilPct"],
    ["getfund", "GETFund levy", "getFundPct"],
    ["covid", "COVID-19 levy", "covidLevyPct"],
    ["vat", "VAT", "vatPct"],
];

const mapToObject = (m) => (m instanceof Map ? Object.fromEntries(m) : (m || {}));

// Recurring plans and their discount setting (% off each visit's fees).
const FREQUENCIES = { once: null, weekly: "weeklyDiscountPct", monthly: "monthlyDiscountPct" };
const PLAN_DEFAULT_DISCOUNT = { weekly: 10, monthly: 5 };
const planDiscountPct = (settings, frequency) => {
    const key = FREQUENCIES[frequency];
    if (!key) return 0;
    const pct = Number(settings.recurring?.[key]);
    return Number.isFinite(pct) ? pct : PLAN_DEFAULT_DISCOUNT[frequency];
};

// Time windows outside normal shifts ("06:00 – 08:00", "16:00 – 18:00").
const isOffHoursWindow = (timeWindow) => /^(06|16|17|18|19)/.test(String(timeWindow || ""));

// Fee settings added after launch: older settings docs may not have them yet.
const FEE_DEFAULTS = { serviceFee: 3, carryFeePerFloor: 3, binWashFee: 15, offHoursFee: 4 };
const fee = (pricing, key) => {
    const v = Number(pricing[key]);
    return Number.isFinite(v) ? v : FEE_DEFAULTS[key] || 0;
};

// settings: the whole CleanBridgeSettings doc (pricing, vehicleFees, tax, payouts, recurring).
// Returns fee lines (breakdown), subtotal, tax lines, total and how the money
// is split between the collector, CleanBridge and GRA.
const quotePickup = (settings, {
    wasteType, bags, distanceKm = 0, urgent = false, scheduledDate, vehicleType,
    timeWindow, floors = 0, binWash = false, frequency = "once",
}) => {
    const pricing = settings.pricing;
    const day = new Date(scheduledDate).getDay();
    const isWeekend = day === 0 || day === 6;
    const wasteTypeFees = pricing.wasteTypeFees instanceof Map
        ? Object.fromEntries(pricing.wasteTypeFees)
        : (pricing.wasteTypeFees || {});
    const floorCount = Math.max(0, Math.min(30, Math.floor(Number(floors) || 0)));

    const breakdown = {
        baseFee: pricing.baseFee,
        serviceFee: fee(pricing, "serviceFee"),
        distanceFee: round2((Number(distanceKm) || 0) * pricing.distanceFeePerKm),
        quantityFee: round2(Number(bags) * pricing.perBagFee),
        wasteTypeFee: wasteTypeFees[wasteType] || 0,
        urgencyFee: urgent ? pricing.urgencyFee : 0,
        weekendFee: isWeekend ? pricing.weekendFee : 0,
        offHoursFee: isOffHoursWindow(timeWindow) ? fee(pricing, "offHoursFee") : 0,
        carryFee: round2(floorCount * fee(pricing, "carryFeePerFloor")),
        binWashFee: binWash ? fee(pricing, "binWashFee") : 0,
        vehicleFee: vehicleType ? (mapToObject(settings.vehicleFees)[vehicleType] || 0) : 0,
    };
    const fees = round2(Object.values(breakdown).reduce((sum, v) => sum + v, 0));
    const discountPct = planDiscountPct(settings, frequency);
    const discount = discountPct ? round2(fees * discountPct / 100) : 0;
    if (discount) breakdown.planDiscount = -discount;
    const subtotal = round2(fees - discount);
    const minimumFee = pricing.minimumFee || 0;
    const minimumTopUp = subtotal < minimumFee ? round2(minimumFee - subtotal) : 0;
    if (minimumTopUp) breakdown.minimumTopUp = minimumTopUp;

    const net = round2(subtotal + minimumTopUp);

    const tax = settings.tax || {};
    const taxes = tax.enabled === false ? [] : TAX_LINES
        .map(([code, label, key]) => ({ code, label, pct: Number(tax[key]) || 0 }))
        .filter((t) => t.pct > 0)
        .map((t) => ({ ...t, amount: round2(net * t.pct / 100) }));
    const taxTotal = round2(taxes.reduce((sum, t) => sum + t.amount, 0));

    const sharePct = settings.payouts?.collectorSharePct ?? 70;
    const collector = round2(net * sharePct / 100);

    return {
        currency: "GHS",
        subtotal: net,
        taxes,
        taxTotal,
        total: round2(net + taxTotal),
        distanceKm: Number(distanceKm) || 0,
        vehicleType: vehicleType || null,
        frequency: FREQUENCIES[frequency] !== undefined ? frequency : "once",
        discountPct,
        breakdown,
        split: { collector, collectorSharePct: sharePct, platform: round2(net - collector), tax: taxTotal },
    };
};

const estimateFuel = ({ distanceKm, fuelEconomyLPer100Km, fuelPricePerLitre }) => {
    const litres = round2((distanceKm * fuelEconomyLPer100Km) / 100);
    return { estimatedFuelLitres: litres, estimatedFuelCost: round2(litres * fuelPricePerLitre) };
};

// =========================
// Collector balance
// available = earnings from completed jobs
//           - cash they collected at the gate (they already hold that money)
//           - payouts already paid or still requested
// A negative balance means the collector owes the platform its fee on cash jobs.
// =========================
const collectorBalance = async (collectorId) => {
    // Required lazily: the Pickup model itself requires this file.
    const Pickup = require("../models/CleanBridgePickup.js");
    const Payout = require("../models/CleanBridgePayout.js");
    const id = mongoose.Types.ObjectId(String(collectorId));

    const [[jobs], payouts] = await Promise.all([
        Pickup.aggregate([
            { $match: { collectorId: id, status: "completed" } },
            {
                $group: {
                    _id: null,
                    jobs: { $sum: 1 },
                    earned: { $sum: { $ifNull: ["$collectorEarning", 0] } },
                    cashCollected: { $sum: { $cond: ["$cashCollected", "$estimatedPrice", 0] } },
                },
            },
        ]),
        Payout.aggregate([
            { $match: { collectorId: id, status: { $in: ["requested", "paid"] } } },
            { $group: { _id: "$status", total: { $sum: "$amount" } } },
        ]),
    ]);

    const paidOut = payouts.find((p) => p._id === "paid")?.total || 0;
    const pending = payouts.find((p) => p._id === "requested")?.total || 0;
    const earned = jobs?.earned || 0;
    const cashCollected = jobs?.cashCollected || 0;

    return {
        completedJobs: jobs?.jobs || 0,
        earned: round2(earned),
        cashCollected: round2(cashCollected),
        paidOut: round2(paidOut),
        pendingPayout: round2(pending),
        available: round2(earned - cashCollected - paidOut - pending),
    };
};

// =========================
// DTOs (id, not _id)
// =========================
const toUserDTO = (user) => ({
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    phone: user.phone ?? null,
    phoneNetwork: detectNetwork(user.phone),
    role: user.role,
    avatarUrl: user.avatarUrl ?? null,
    avatarSource: user.avatarSource ?? null,
    googleLinked: Boolean(user.googleId),
    hasPassword: Boolean(user.password),
    area: user.area ?? null,
    address: user.address ?? null,
    region: user.region ?? null,
    ghanaPostGps: user.ghanaPostGps ?? null,
    location: user.location ? { lat: user.location.lat, lng: user.location.lng } : null,
    collectorStatus: user.role === "collector" ? user.collectorStatus : undefined,
    momoNumber: user.role === "collector" ? user.momoNumber ?? null : undefined,
    momoNetwork: user.role === "collector" ? user.momoNetwork ?? null : undefined,
    rating: user.rating ?? null,
    ratingCount: user.ratingCount ?? 0,
    isActive: user.isActive,
    emailNotifications: user.emailNotifications !== false,
    profileComplete: Boolean(user.phone),
    createdAt: user.createdAt,
});

const toPickupDTO = (p) => ({
    id: p._id.toString(),
    code: p.code,
    customerId: p.customerId?.toString(),
    customerName: p.customerName,
    customerPhone: p.customerPhone,
    area: p.area,
    address: p.address,
    region: p.region,
    ghanaPostGps: p.ghanaPostGps,
    location: p.location?.lat != null ? { lat: p.location.lat, lng: p.location.lng } : null,
    hubName: p.hubName,
    gateNote: p.gateNote,
    wasteType: p.wasteType,
    bags: p.bags,
    scheduledDate: p.scheduledDate,
    timeWindow: p.timeWindow,
    urgent: p.urgent,
    distanceKm: p.distanceKm,
    estimatedPrice: p.estimatedPrice,
    priceBreakdown: p.priceBreakdown,
    subtotal: p.subtotal ?? p.estimatedPrice,
    taxes: p.taxes || [],
    taxAmount: p.taxAmount || 0,
    vehicleType: p.vehicleType || null,
    floors: p.floors || 0,
    binWash: Boolean(p.binWash),
    subscriptionId: p.subscriptionId?.toString() || null,
    frequency: p.frequency || "once",
    paymentMethod: p.paymentMethod,
    paymentStatus: p.paymentStatus,
    paymentChannel: p.paymentChannel,
    paymentChannelLabel: p.paymentChannelLabel,
    cashCollected: p.cashCollected,
    paidAt: p.paidAt,
    collectorEarning: p.collectorEarning,
    platformFee: p.platformFee,
    status: p.status,
    collectorId: p.collectorId?.toString() || null,
    collectorName: p.collectorName,
    collectorPhone: p.collectorPhone,
    vehicleLabel: p.vehicleLabel,
    routeId: p.routeId?.toString() || null,
    etaMinutes: p.etaMinutes,
    customerRating: p.customerRating,
    assignedAt: p.assignedAt,
    startedAt: p.startedAt,
    completedAt: p.completedAt,
    cancelledAt: p.cancelledAt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
});

const toVehicleDTO = (v) => ({
    id: v._id.toString(),
    collectorId: v.collectorId?.toString(),
    label: v.label,
    type: v.type,
    make: v.make,
    model: v.model,
    registration: v.registration,
    fuelType: v.fuelType,
    fuelEconomyLPer100Km: v.fuelEconomyLPer100Km,
    capacityTonnes: v.capacityTonnes,
    verificationStatus: v.verificationStatus,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
});

const vehicleLabel = (v) => (v ? `${v.label ? `${v.label} · ` : ""}${v.make} ${v.model}` : null);

const toRouteDTO = (r) => ({
    id: r._id.toString(),
    code: r.code,
    collectorId: r.collectorId?.toString(),
    collectorName: r.collectorName,
    date: r.date,
    stops: (r.stops || []).map((s) => (s && s._id && s.code ? toPickupDTO(s) : s.toString())),
    stopCount: (r.stops || []).length,
    distanceKm: r.distanceKm,
    fuelPricePerLitre: r.fuelPricePerLitre,
    estimatedFuelLitres: r.estimatedFuelLitres,
    estimatedFuelCost: r.estimatedFuelCost,
    status: r.status,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    createdAt: r.createdAt,
});

const toNotificationDTO = (n) => ({
    id: n._id.toString(),
    title: n.title,
    message: n.message,
    pickupId: n.pickupId?.toString() || null,
    read: n.read,
    createdAt: n.createdAt,
});

const toPayoutDTO = (p) => ({
    id: p._id.toString(),
    collectorId: p.collectorId?.toString(),
    collectorName: p.collectorName,
    amount: p.amount,
    momoNumber: p.momoNumber,
    momoNetwork: p.momoNetwork,
    status: p.status,
    reference: p.reference,
    note: p.note,
    processedAt: p.processedAt,
    createdAt: p.createdAt,
});

const toSettingsDTO = (s) => ({
    pricing: {
        baseFee: s.pricing.baseFee,
        distanceFeePerKm: s.pricing.distanceFeePerKm,
        perBagFee: s.pricing.perBagFee,
        urgencyFee: s.pricing.urgencyFee,
        weekendFee: s.pricing.weekendFee,
        minimumFee: s.pricing.minimumFee,
        serviceFee: fee(s.pricing, "serviceFee"),
        carryFeePerFloor: fee(s.pricing, "carryFeePerFloor"),
        binWashFee: fee(s.pricing, "binWashFee"),
        offHoursFee: fee(s.pricing, "offHoursFee"),
        wasteTypeFees: Object.fromEntries(s.pricing.wasteTypeFees || []),
    },
    vehicleFees: Object.fromEntries(s.vehicleFees || []),
    tax: {
        enabled: s.tax?.enabled !== false,
        vatPct: s.tax?.vatPct ?? 15,
        nhilPct: s.tax?.nhilPct ?? 2.5,
        getFundPct: s.tax?.getFundPct ?? 2.5,
        covidLevyPct: s.tax?.covidLevyPct ?? 0,
    },
    recurring: {
        weeklyDiscountPct: planDiscountPct(s, "weekly"),
        monthlyDiscountPct: planDiscountPct(s, "monthly"),
    },
    payouts: {
        collectorSharePct: s.payouts?.collectorSharePct ?? 70,
        minimumPayout: s.payouts?.minimumPayout ?? 20,
    },
    fuel: {
        fuelType: s.fuel.fuelType,
        currentPrice: s.fuel.currentPrice,
        previousPrice: s.fuel.previousPrice,
        effectiveDate: s.fuel.effectiveDate,
    },
    updatedAt: s.updatedAt,
});

const toSubscriptionDTO = (s) => ({
    id: s._id.toString(),
    code: s.code,
    customerId: s.customerId?.toString(),
    customerName: s.customerName,
    customerPhone: s.customerPhone,
    frequency: s.frequency,
    dayOfWeek: s.dayOfWeek,
    dayOfMonth: s.dayOfMonth,
    area: s.area,
    address: s.address,
    region: s.region,
    ghanaPostGps: s.ghanaPostGps,
    gateNote: s.gateNote,
    location: s.location?.lat != null ? { lat: s.location.lat, lng: s.location.lng } : null,
    hubName: s.hubName,
    wasteType: s.wasteType,
    bags: s.bags,
    vehicleType: s.vehicleType,
    timeWindow: s.timeWindow,
    floors: s.floors || 0,
    binWash: Boolean(s.binWash),
    paymentMethod: s.paymentMethod,
    pricePerVisit: s.pricePerVisit,
    discountPct: s.discountPct || 0,
    status: s.status,
    startDate: s.startDate,
    nextDate: s.status === "active" ? s.nextDate : null,
    visitsBooked: s.visitsBooked || 0,
    lastPickupId: s.lastPickupId?.toString() || null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
});

module.exports = {
    nextSequence,
    quotePickup,
    FREQUENCIES,
    isOffHoursWindow,
    toSubscriptionDTO,
    estimateFuel,
    collectorBalance,
    round2,
    toUserDTO,
    toPickupDTO,
    toVehicleDTO,
    vehicleLabel,
    toRouteDTO,
    toNotificationDTO,
    toPayoutDTO,
    toSettingsDTO,
};
