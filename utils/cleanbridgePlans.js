const Subscription = require("../models/CleanBridgeSubscription.js");
const CleanBridgeUser = require("../models/CleanBridgeUser.js");
const Settings = require("../models/CleanBridgeSettings.js");
const { serviceInfo } = require("./ghana.js");

// Recurring plans book each visit as a normal pickup this many days ahead,
// so collectors see it early and customers get a reminder.
const LEAD_DAYS = 2;
const DAY_MS = 86400000;

// Dates are whole days at UTC midnight (Ghana is UTC+0 all year).
const utcDay = (value) => {
    const d = new Date(value);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

// The visit after `date` for this plan.
const followingVisit = (plan, date) => {
    const d = utcDay(date);
    if (plan.frequency === "weekly") return new Date(d.getTime() + 7 * DAY_MS);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, plan.dayOfMonth || d.getUTCDate()));
};

// First visit on or after `date` (used when a plan resumes after a pause).
const nextVisitFrom = (plan, date) => {
    const from = utcDay(date);
    if (plan.frequency === "weekly") {
        const add = (plan.dayOfWeek - from.getUTCDay() + 7) % 7;
        return new Date(from.getTime() + add * DAY_MS);
    }
    const day = plan.dayOfMonth || 1;
    const sameMonth = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), day));
    return sameMonth >= from ? sameMonth : new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, day));
};

const planOrder = (plan) => ({
    area: plan.area,
    address: plan.address,
    region: plan.region,
    ghanaPostGps: plan.ghanaPostGps,
    location: { lat: plan.location.lat, lng: plan.location.lng },
    hubId: plan.hubId,
    hubName: plan.hubName,
    gateNote: plan.gateNote,
    wasteType: plan.wasteType,
    bags: plan.bags,
    timeWindow: plan.timeWindow,
    urgent: false,
    vehicleType: plan.vehicleType,
    paymentMethod: plan.paymentMethod,
    floors: plan.floors,
    binWash: plan.binWash,
});

// Books one visit of `plan` for `date`. The claim on nextDate is atomic, so
// two servers (or two overlapping runs) can never book the same visit twice.
const bookVisit = async (plan, date, settings) => {
    const { bookPickup } = require("../controllers/cleanbridgePickup.js");
    const claimed = await Subscription.findOneAndUpdate(
        { _id: plan._id, status: "active", nextDate: plan.nextDate },
        { nextDate: followingVisit(plan, date), $inc: { visitsBooked: 1 } },
        { new: true }
    );
    if (!claimed) return null;
    const customer = await CleanBridgeUser.findById(plan.customerId);
    if (!customer || !customer.isActive) return null;
    const service = serviceInfo(plan.location.lat, plan.location.lng);
    if (!service.serviceable) return null;
    const { pickup, quote } = await bookPickup({
        customer, order: planOrder(plan), distanceKm: service.distanceKm, scheduledDate: date, settings, subscription: claimed,
    });
    claimed.lastPickupId = pickup._id;
    claimed.pricePerVisit = quote.total;
    claimed.discountPct = quote.discountPct;
    await claimed.save();
    return pickup;
};

// Books every visit that falls within the lead time. Visits missed while the
// server was asleep are skipped forward rather than booked in the past.
let running = null;
const bookDueVisits = () => {
    if (running) return running;
    running = (async () => {
        const today = utcDay(Date.now());
        const horizon = new Date(today.getTime() + LEAD_DAYS * DAY_MS);
        const due = await Subscription.find({ status: "active", nextDate: { $lte: horizon } }).limit(500);
        if (!due.length) return 0;
        const settings = await Settings.getGlobal();
        let booked = 0;
        for (const plan of due) {
            try {
                let current = plan;
                while (current && current.nextDate <= horizon) {
                    if (current.nextDate < today) {
                        current = await Subscription.findOneAndUpdate(
                            { _id: current._id, nextDate: current.nextDate },
                            { nextDate: nextVisitFrom(current, today) },
                            { new: true }
                        );
                        continue;
                    }
                    const pickup = await bookVisit(current, current.nextDate, settings);
                    if (!pickup) break;
                    booked += 1;
                    current = await Subscription.findById(current._id);
                }
            } catch (err) {
                console.error(`[cleanbridge plans] ${plan.code}: ${err.message}`);
            }
        }
        return booked;
    })().finally(() => { running = null; });
    return running;
};

// Runs every 30 minutes, plus whenever plans or open jobs are listed (Render's
// free plan sleeps, so a timer alone could miss days).
let timer = null;
const startPlanScheduler = () => {
    if (timer) return;
    timer = setInterval(() => { bookDueVisits().catch(() => {}); }, 30 * 60 * 1000);
    timer.unref?.();
    setTimeout(() => { bookDueVisits().catch(() => {}); }, 15000).unref?.();
};

module.exports = { bookDueVisits, bookVisit, startPlanScheduler, followingVisit, nextVisitFrom, utcDay, planOrder, LEAD_DAYS };
