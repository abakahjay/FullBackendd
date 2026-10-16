const Pickup = require("../models/CleanBridgePickup.js");
const Route = require("../models/CleanBridgeRoute.js");
const Vehicle = require("../models/CleanBridgeVehicle.js");
const Settings = require("../models/CleanBridgeSettings.js");
const CleanBridgeUser = require("../models/CleanBridgeUser.js");
const { notify } = require("../utils/cleanbridgeNotify.js");
const { BadRequestError, NotFoundError } = require("../errors");
const { StatusCodes } = require("http-status-codes");
const { estimateFuel, round2, toPickupDTO, toRouteDTO, vehicleLabel } = require("../utils/cleanbridge.js");
const { haversineKm, ROAD_FACTOR, serviceInfo, SERVICE_HUBS, VEHICLE_INFO, VEHICLE_TYPES, recommendVehicle } = require("../utils/ghana.js");
const { readyCollectors } = require("./cleanbridgePickup.js");
const { bookDueVisits, utcDay } = require("../utils/cleanbridgePlans.js");

// Area dispatch: group the day's open pickups that sit close together, so
// operations can send one vehicle to a whole neighbourhood instead of one
// trip per household.

const DAY_MS = 86400000;
const MAX_STOPS = 25;
const MAX_POINTS = 400;
// Typical diesel use (L/100km) when we don't know the exact vehicle yet.
// Mirrors VEHICLE_ECONOMY in the frontend's lib/ghana.js.
const TYPICAL_ECONOMY = {
    "Motor tricycle (Aboboyaa)": 4.5, "Mini truck": 8.5, "Light truck": 10, "Tipper truck": 22, "Compactor truck": 35,
};
const rank = (type) => VEHICLE_TYPES.indexOf(type);

const dayRange = (value) => {
    const start = utcDay(value && value !== "today" ? value : Date.now());
    if (Number.isNaN(start.getTime())) throw new BadRequestError("date must look like 2026-10-20");
    return { start, end: new Date(start.getTime() + DAY_MS) };
};

// Groups points so every member is within radiusKm of its group's seed. The
// seed is the point with the most open neighbours, so dense streets come first.
const clusterPoints = (points, radiusKm) => {
    const near = points.map((p) => points
        .map((q, j) => ({ j, km: haversineKm(p.location, q.location) }))
        .filter((x) => x.km <= radiusKm));
    const left = new Set(points.map((_, i) => i));
    const groups = [];
    while (left.size) {
        let seed = -1;
        let best = -1;
        left.forEach((i) => {
            const count = near[i].filter((x) => left.has(x.j)).length;
            if (count > best) { best = count; seed = i; }
        });
        const members = near[seed]
            .filter((x) => left.has(x.j))
            .sort((a, b) => a.km - b.km)
            .slice(0, MAX_STOPS)
            .map((x) => x.j);
        members.forEach((j) => left.delete(j));
        groups.push(members.map((j) => points[j]));
    }
    return groups;
};

// Nearest-neighbour stop order from `start`, plus the road distance of the
// whole run (back to `end` when given, e.g. the hub / dump site).
const orderStops = (start, stops, end = null) => {
    const left = [...stops];
    const ordered = [];
    let here = start;
    let km = 0;
    while (left.length) {
        let bestIdx = 0;
        let bestKm = Infinity;
        left.forEach((s, i) => {
            const d = haversineKm(here, s.location);
            if (d < bestKm) { bestKm = d; bestIdx = i; }
        });
        const [next] = left.splice(bestIdx, 1);
        km += bestKm;
        ordered.push(next);
        here = next.location;
    }
    if (end) km += haversineKm(here, end);
    return { ordered, distanceKm: round2(km * ROAD_FACTOR) };
};

// The smallest vehicle that is allowed for every load in the group and fits them all.
const vehicleFor = (pickups, totalBags) => {
    const minRank = Math.max(0, ...pickups.map((p) => rank(recommendVehicle(p.wasteType, 1))));
    const fit = VEHICLE_TYPES.find((t, i) => i >= minRank && VEHICLE_INFO[t].capacityBags >= totalBags);
    return { type: fit || VEHICLE_TYPES[VEHICLE_TYPES.length - 1], minRank, overCapacity: !fit };
};

const centroidOf = (pickups) => ({
    lat: pickups.reduce((s, p) => s + p.location.lat, 0) / pickups.length,
    lng: pickups.reduce((s, p) => s + p.location.lng, 0) / pickups.length,
});

// Nearest hub with its coordinates (serviceInfo() only returns its name).
const hubNear = (point) => {
    const id = serviceInfo(point.lat, point.lng).hub?.id;
    return SERVICE_HUBS.find((h) => h.id === id) || null;
};

const mostCommon = (values) => {
    const counts = new Map();
    values.filter(Boolean).forEach((v) => counts.set(v, (counts.get(v) || 0) + 1));
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "Unnamed area";
};

// =========================
// GET /admin/dispatch/clusters?date=YYYY-MM-DD&radiusKm=2
// Open, unassigned pickups for the day, grouped by neighbourhood, with the
// suggested vehicle, run distance, fuel, revenue and nearby collectors.
// =========================
const listClusters = async (req, res) => {
    await bookDueVisits().catch(() => {});
    const { start, end } = dayRange(req.query.date);
    const radiusKm = Math.min(Math.max(Number(req.query.radiusKm) || 2, 0.3), 15);

    const open = await Pickup.find({
        status: "requested",
        collectorId: null,
        scheduledDate: { $gte: start, $lt: end },
        "location.lat": { $ne: null },
    }).sort({ urgent: -1, timeWindow: 1 }).limit(MAX_POINTS);

    const [settings, ready] = await Promise.all([Settings.getGlobal(), readyCollectors()]);
    const share = (settings.payouts?.collectorSharePct ?? 70) / 100;
    const fuelPrice = settings.fuel.currentPrice;

    const clusters = clusterPoints(open, radiusKm).map((members) => {
        const centre = centroidOf(members);
        const hub = hubNear(centre);
        const totalBags = members.reduce((s, p) => s + p.bags, 0);
        const vehicle = vehicleFor(members, totalBags);
        const { ordered, distanceKm } = orderStops(hub || centre, members, hub);
        const revenue = round2(members.reduce((s, p) => s + (p.subtotal ?? p.estimatedPrice), 0));
        const fuel = estimateFuel({ distanceKm, fuelEconomyLPer100Km: TYPICAL_ECONOMY[vehicle.type], fuelPricePerLitre: fuelPrice });
        const soloKm = round2(members.reduce((s, p) => s + (p.distanceKm || 0) * 2, 0));

        const collectors = ready
            .filter((c) => rank(c.vehicleType) >= vehicle.minRank && VEHICLE_INFO[c.vehicleType]?.capacityBags >= Math.min(totalBags, 300))
            .map((c) => ({ id: String(c.id), name: c.name, vehicleType: c.vehicleType, capacityBags: VEHICLE_INFO[c.vehicleType]?.capacityBags || 0 }));

        return {
            id: `${ordered[0].code}-${ordered.length}`,
            area: mostCommon(members.map((p) => p.area)),
            centre,
            radiusKm: round2(Math.max(0.2, ...members.map((p) => haversineKm(centre, p.location)))),
            hubName: hub?.name || null,
            stops: ordered.map((p) => ({ ...toPickupDTO(p), estimatedEarning: round2((p.subtotal ?? p.estimatedPrice) * share) })),
            stopCount: ordered.length,
            totalBags,
            timeWindows: [...new Set(ordered.map((p) => p.timeWindow))].sort(),
            urgent: ordered.some((p) => p.urgent),
            recommendedVehicle: vehicle.type,
            overCapacity: vehicle.overCapacity,
            routeKm: distanceKm,
            // Driving each job as its own round trip from the hub, for comparison.
            separateTripsKm: soloKm,
            fuelLitres: fuel.estimatedFuelLitres,
            fuelCost: fuel.estimatedFuelCost,
            revenue,
            collectorPay: round2(revenue * share),
            suitableCollectors: collectors,
        };
    }).sort((a, b) => b.stopCount - a.stopCount || b.revenue - a.revenue);

    // Distance from each suitable collector to the cluster (live GPS first).
    const ids = [...new Set(clusters.flatMap((c) => c.suitableCollectors.map((s) => s.id)))];
    const where = await CleanBridgeUser.find({ _id: { $in: ids } }).select("lastLocation location collectorStatus");
    const pos = new Map(where.map((u) => [String(u._id), {
        at: u.lastLocation?.lat != null ? u.lastLocation : u.location,
        status: u.collectorStatus,
    }]));
    clusters.forEach((c) => {
        c.suitableCollectors = c.suitableCollectors
            .map((s) => {
                const p = pos.get(s.id);
                const km = p?.at?.lat != null ? round2(haversineKm(p.at, c.centre) * ROAD_FACTOR) : null;
                return { ...s, km, status: p?.status || null };
            })
            .sort((a, b) => (a.km ?? 1e9) - (b.km ?? 1e9))
            .slice(0, 8);
    });

    return res.status(StatusCodes.OK).json({
        date: start.toISOString().slice(0, 10),
        radiusKm,
        openPickups: open.length,
        clusters,
    });
};

// =========================
// POST /admin/dispatch   { pickupIds: [...], collectorId }
// Assigns a whole group to one collector and puts it on their route for that
// day (added to a planned route they already have, or a new one).
// =========================
const dispatchCluster = async (req, res) => {
    const { pickupIds, collectorId } = req.body;
    if (!Array.isArray(pickupIds) || pickupIds.length === 0 || !collectorId) {
        throw new BadRequestError("Please choose the pickups and a collector");
    }
    if (pickupIds.length > MAX_STOPS) throw new BadRequestError(`Send at most ${MAX_STOPS} stops in one run`);

    const collector = await CleanBridgeUser.findOne({ _id: collectorId, role: "collector", isActive: true });
    if (!collector) throw new NotFoundError(`No active collector with id: ${collectorId}`);
    const vehicle = await Vehicle.findOne({ collectorId: collector._id });
    if (!vehicle || vehicle.verificationStatus !== "verified") {
        throw new BadRequestError(`${collector.name} needs a verified vehicle before taking jobs`);
    }

    const candidates = await Pickup.find({ _id: { $in: pickupIds }, status: "requested", collectorId: null });
    if (!candidates.length) throw new BadRequestError("These pickups have already been taken or cancelled");
    const totalBags = candidates.reduce((s, p) => s + p.bags, 0);
    const need = vehicleFor(candidates, totalBags);
    if (rank(vehicle.type) < need.minRank) {
        throw new BadRequestError(`This group includes loads that need at least a ${VEHICLE_TYPES[need.minRank]}; ${collector.name} drives a ${vehicle.type}`);
    }
    const capacity = VEHICLE_INFO[vehicle.type]?.capacityBags || 0;
    if (capacity < totalBags) {
        throw new BadRequestError(`${totalBags} bags is more than a ${vehicle.type} carries (about ${capacity}). Pick a bigger vehicle or fewer stops.`);
    }

    // Atomic per pickup: anything a collector accepted in the meantime is skipped.
    const label = vehicleLabel(vehicle);
    const assigned = [];
    for (const p of candidates) {
        const updated = await Pickup.findOneAndUpdate(
            { _id: p._id, status: "requested", collectorId: null },
            {
                collectorId: collector._id,
                collectorName: collector.name,
                collectorPhone: collector.phone || null,
                vehicleLabel: label,
                status: "assigned",
                assignedAt: new Date(),
            },
            { new: true }
        );
        if (updated) assigned.push(updated);
    }
    if (!assigned.length) throw new BadRequestError("These pickups have already been taken");

    const day = utcDay(assigned[0].scheduledDate);
    const settings = await Settings.getGlobal();
    let route = await Route.findOne({
        collectorId: collector._id,
        status: "planned",
        date: { $gte: day, $lt: new Date(day.getTime() + DAY_MS) },
    }).populate("stops");

    const existing = (route?.stops || []).filter((s) => s && ["assigned", "on_the_way"].includes(s.status));
    const allStops = [...existing, ...assigned];
    const hub = hubNear(allStops[0].location);
    const startAt = collector.lastLocation?.lat != null ? collector.lastLocation : hub;
    const { ordered, distanceKm } = orderStops(startAt || hub, allStops, hub);
    const fuel = estimateFuel({ distanceKm, fuelEconomyLPer100Km: vehicle.fuelEconomyLPer100Km, fuelPricePerLitre: settings.fuel.currentPrice });

    if (route) {
        route.stops = ordered.map((s) => s._id);
        route.distanceKm = distanceKm;
        route.fuelPricePerLitre = settings.fuel.currentPrice;
        route.estimatedFuelLitres = fuel.estimatedFuelLitres;
        route.estimatedFuelCost = fuel.estimatedFuelCost;
        await route.save();
    } else {
        route = await Route.create({
            collectorId: collector._id,
            collectorName: collector.name,
            date: day,
            stops: ordered.map((s) => s._id),
            distanceKm,
            fuelPricePerLitre: settings.fuel.currentPrice,
            ...fuel,
        });
    }
    await Pickup.updateMany({ _id: { $in: ordered.map((s) => s._id) } }, { routeId: route._id });
    if (collector.collectorStatus === "off_duty") {
        collector.collectorStatus = "available";
        await collector.save();
    }

    const share = (settings.payouts?.collectorSharePct ?? 70) / 100;
    const earn = round2(assigned.reduce((s, p) => s + (p.subtotal ?? p.estimatedPrice) * share, 0));
    const area = mostCommon(assigned.map((p) => p.area));
    const when = day.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Africa/Accra" });
    await Promise.all([
        notify(collector._id, "Area run assigned",
            `${assigned.length} pickup${assigned.length === 1 ? "" : "s"} in ${area} on ${when} · ${assigned.reduce((s, p) => s + p.bags, 0)} bags · ${distanceKm} km · earn about GH₵ ${earn.toFixed(2)}. Open Today's route for the stop order.`,
            { ctaPath: "/collector/route", ctaLabel: "Open route", kind: "new_request" }),
        ...assigned.map((p) => notify(p.customerId, "Collector assigned",
            `${collector.name} will collect ${p.code} with ${label || "their vehicle"} on ${when}, ${p.timeWindow}.`, { pickupId: p._id })),
    ]);

    await route.populate("stops").execPopulate();
    const takenIds = new Set(assigned.map((p) => String(p._id)));
    return res.status(StatusCodes.OK).json({
        route: toRouteDTO(route),
        assigned: assigned.length,
        skipped: candidates.filter((p) => !takenIds.has(String(p._id))).map((p) => p.code),
    });
};

module.exports = { listClusters, dispatchCluster, clusterPoints, orderStops };
