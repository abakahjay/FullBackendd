const express = require("express");
const router = express.Router();
const cleanbridgeAuth = require("../middleware/cleanbridgeAuth.js");
const { requireRole } = require("../middleware/cleanbridgeAuth.js");
const {
    listSubscriptions,
    createSubscription,
    updateSubscriptionStatus,
    updateSubscription,
} = require("../controllers/cleanbridgeSubscription.js");
const { startPlanScheduler } = require("../utils/cleanbridgePlans.js");

// Weekly / monthly collection plans.
startPlanScheduler();

router.use(cleanbridgeAuth);
router.get("/", requireRole("customer", "admin"), listSubscriptions);
router.post("/", requireRole("customer"), createSubscription);
router.patch("/:id/status", requireRole("customer", "admin"), updateSubscriptionStatus);
router.patch("/:id", requireRole("customer", "admin"), updateSubscription);

module.exports = router;
