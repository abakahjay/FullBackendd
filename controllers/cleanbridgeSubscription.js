const Subscription = require("../models/CleanBridgeSubscription.js");
const Pickup = require("../models/CleanBridgePickup.js");
const CleanBridgeUser = require("../models/CleanBridgeUser.js");
const Settings = require("../models/CleanBridgeSettings.js");
const { notify } = require("../utils/cleanbridgeNotify.js");
const { BadRequestError, NotFoundError, UnauthorizedError } = require("../errors");
const { StatusCodes } = require("http-status-codes");
const { quotePickup, toSubscriptionDTO, toPickupDTO } = require("../utils/cleanbridge.js");
const { readOrderInput, startOfToday } = require("./cleanbridgePickup.js");
const { bookDueVisits, bookVisit, nextVisitFrom, utcDay, planOrder } = require("../utils/cleanbridgePlans.js");

const FREQUENCY_LABEL = { weekly: "Weekly", monthly: "Monthly" };

const findPlanFor = async (id, user) => {
    const plan = await Subscription.findById(id);
    if (!plan) throw new NotFoundError(`No plan with id: ${id}`);
    if (user.role !== "admin" && String(plan.customerId) !== String(user.userId)) {
        throw new UnauthorizedError("You are not authorized to change this plan");
    }
    return plan;
};

// The plan's upcoming visits that nobody has started on yet.
const upcomingVisits = (planId) => Pickup.find({
    subscriptionId: planId,
    status: { $in: ["requested", "assigned"] },
    scheduledDate: { $gte: startOfToday() },
}).sort({ scheduledDate: 1 });

// =========================
// GET /subscriptions   customer -> own plans, admin -> all   ?status=
// =========================
const listSubscriptions = async (req, res) => {
    await bookDueVisits().catch(() => {});
    const filter = {};
    if (req.user.role !== "admin") filter.customerId = req.user.userId;
    if (req.query.status) filter.status = { $in: String(req.query.status).split(",") };
    const plans = await Subscription.find(filter).sort({ status: 1, nextDate: 1 }).limit(200);

    const upcoming = await Pickup.find({
        subscriptionId: { $in: plans.map((p) => p._id) },
        status: { $in: ["requested", "assigned", "on_the_way"] },
    }).sort({ scheduledDate: 1 });
    const byPlan = new Map();
    upcoming.forEach((p) => {
        const key = String(p.subscriptionId);
        if (!byPlan.has(key)) byPlan.set(key, toPickupDTO(p));
    });

    return res.status(StatusCodes.OK).json({
        subscriptions: plans.map((p) => ({ ...toSubscriptionDTO(p), upcomingPickup: byPlan.get(String(p._id)) || null })),
    });
};

// =========================
// POST /subscriptions   (customer)
// { frequency: weekly|monthly, startDate, ...same order fields as POST /pickups }
// The first visit is booked straight away; later ones LEAD_DAYS ahead.
// =========================
const createSubscription = async (req, res) => {
    const { frequency, startDate } = req.body;
    if (!FREQUENCY_LABEL[frequency]) throw new BadRequestError("frequency must be weekly or monthly");
    const { order, service } = readOrderInput({ ...req.body, scheduledDate: startDate });
    const start = utcDay(startDate);
    if (start < utcDay(Date.now())) throw new BadRequestError("The first pickup cannot be in the past");

    const customer = await CleanBridgeUser.findById(req.user.userId);
    if (!customer.phone) {
        throw new BadRequestError("Add your phone number to your profile so your collector can reach you");
    }
    const open = await Subscription.countDocuments({ customerId: customer._id, status: { $ne: "cancelled" } });
    if (open >= 10) throw new BadRequestError("You can have up to 10 plans. Cancel one you no longer need first.");

    const settings = await Settings.getGlobal();
    const quote = quotePickup(settings, { ...order, distanceKm: service.distanceKm, scheduledDate: start, frequency });

    const plan = await Subscription.create({
        ...order,
        urgent: undefined,
        customerId: customer._id,
        customerName: customer.name,
        customerPhone: customer.phone,
        frequency,
        dayOfWeek: start.getUTCDay(),
        dayOfMonth: Math.min(start.getUTCDate(), 28),
        startDate: start,
        nextDate: start,
        pricePerVisit: quote.total,
        discountPct: quote.discountPct,
    });

    const pickup = await bookVisit(plan, start, settings);
    if (!customer.location) {
        customer.location = order.location;
        customer.address = customer.address || order.address;
        customer.area = customer.area || order.area;
        await customer.save();
    }

    const fresh = await Subscription.findById(plan._id);
    return res.status(StatusCodes.CREATED).json({
        subscription: toSubscriptionDTO(fresh),
        pickup: pickup ? toPickupDTO(pickup) : null,
        quote,
    });
};

// =========================
// PATCH /subscriptions/:id/status   { status: active | paused | cancelled }
// Pausing or cancelling also cancels visits that are booked but not started
// (except ones already paid online).
// =========================
const PLAN_TRANSITIONS = { active: ["paused", "cancelled"], paused: ["active", "cancelled"], cancelled: [] };

const updateSubscriptionStatus = async (req, res) => {
    const { status } = req.body;
    const plan = await findPlanFor(req.params.id, req.user);
    if (!PLAN_TRANSITIONS[plan.status].includes(status)) {
        throw new BadRequestError(`Cannot change a ${plan.status} plan to "${status}"`);
    }

    let cancelledVisits = 0;
    if (status === "active") {
        plan.nextDate = nextVisitFrom(plan, utcDay(Date.now()));
    } else {
        const toCancel = (await upcomingVisits(plan._id)).filter((v) => v.paymentStatus !== "paid");
        await Pickup.updateMany(
            { _id: { $in: toCancel.map((v) => v._id) } },
            { status: "cancelled", cancelledAt: new Date() }
        );
        cancelledVisits = toCancel.length;
        await Promise.all(toCancel.filter((v) => v.collectorId).map((v) => notify(v.collectorId, "Pickup cancelled",
            `Pickup ${v.code} in ${v.area} was cancelled because the customer ${status === "paused" ? "paused" : "cancelled"} their plan.`,
            { pickupId: v._id, email: false })));
    }
    plan.status = status;
    if (status === "cancelled") plan.cancelledAt = new Date();
    await plan.save();

    const verb = { active: "resumed", paused: "paused", cancelled: "cancelled" }[status];
    const visitsNote = cancelledVisits
        ? ` ${cancelledVisits} upcoming visit${cancelledVisits === 1 ? " was" : "s were"} cancelled.` : "";
    await notify(plan.customerId, `Plan ${verb}`,
        `Your ${plan.frequency} plan ${plan.code} is ${verb}.${visitsNote}${status === "active" ? " We will book your next visit automatically." : ""}`,
        { ctaPath: "/plans", email: false });

    if (status === "active") await bookDueVisits().catch(() => {});
    const fresh = await Subscription.findById(plan._id);
    return res.status(StatusCodes.OK).json({ subscription: toSubscriptionDTO(fresh), cancelledVisits });
};

// =========================
// PATCH /subscriptions/:id   (owner or admin)
// { bags?, wasteType?, timeWindow?, floors?, binWash?, paymentMethod?, vehicleType?, gateNote? }
// Applies to visits booked from now on.
// =========================
const EDITABLE = ["bags", "wasteType", "timeWindow", "floors", "binWash", "paymentMethod", "vehicleType", "gateNote"];

const updateSubscription = async (req, res) => {
    const plan = await findPlanFor(req.params.id, req.user);
    if (plan.status === "cancelled") throw new BadRequestError("This plan has been cancelled");

    const changes = Object.fromEntries(EDITABLE.filter((k) => req.body[k] !== undefined).map((k) => [k, req.body[k]]));
    const merged = { ...planOrder(plan), ...changes, scheduledDate: plan.nextDate };
    // A new load may need a different vehicle: recommend one unless it was chosen.
    if ((changes.wasteType || changes.bags) && !changes.vehicleType) merged.vehicleType = null;
    const { order, service } = readOrderInput(merged);
    EDITABLE.forEach((k) => { if (order[k] !== undefined) plan[k] = order[k]; });

    const settings = await Settings.getGlobal();
    const quote = quotePickup(settings, { ...order, distanceKm: service.distanceKm, scheduledDate: plan.nextDate, frequency: plan.frequency });
    plan.pricePerVisit = quote.total;
    plan.discountPct = quote.discountPct;
    await plan.save();

    return res.status(StatusCodes.OK).json({ subscription: toSubscriptionDTO(plan), quote });
};

module.exports = { listSubscriptions, createSubscription, updateSubscriptionStatus, updateSubscription };
