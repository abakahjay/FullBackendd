const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const { requireRole, isAdmin } = require("../middleware/auth");
const adminOnly = require("../middleware/adminOnly");
const FoodOrders = require("../models/FoodOrders");
const { NotFoundError } = require("../errors");
const {
  createOrder,
  getUserOrders,
  getAllOrders,
  getTotalSpent,
  deleteOrder,
  updateOrderStatus,
  getCatererAnalytics,
  getAdminAnalytics,
  setWeeklyMenu,
  createWeeklyOrder,
  updateDailyOrder,
} = require("../controllers/foodorders");

// Every food-order route needs the shared User JWT. The user is always taken from the token:
// a non-admin's body/param userId is overwritten, so nobody can order, read or change for
// someone else. Admins may still act for any user (they send the userId).
router.use(authMiddleware);

const asSelf = (req, res, next) => {
  if (!isAdmin(req)) {
    if (req.body && typeof req.body === "object") req.body.userId = req.user.userId;
    if (req.params.userId !== undefined) req.params.userId = req.user.userId;
  }
  next();
};
const selfParam = (req, res, next) => {
  if (!isAdmin(req) && req.user.role !== "caterer" && req.params.userId !== req.user.userId) {
    throw new NotFoundError("No orders found.");
  }
  next();
};
// Delete: the order's owner, or an admin/caterer.
const ownOrderOrStaff = async (req, res, next) => {
  if (isAdmin(req) || req.user.role === "caterer") return next();
  const order = /^[a-f0-9]{24}$/i.test(req.params.orderId)
    ? await FoodOrders.findById(req.params.orderId).select("userId").lean()
    : null;
  if (!order || String(order.userId) !== String(req.user.userId)) {
    throw new NotFoundError(`No order found with id:${req.params.orderId}`);
  }
  next();
};
const staff = requireRole("admin", "caterer");

router.post("/", asSelf, createOrder);
router.get("/user/:userId", selfParam, getUserOrders);
router.get("/all", staff, getAllOrders);
router.get("/total", adminOnly, getTotalSpent);
router.get("/admin-data", adminOnly, getAdminAnalytics);
router.get("/caterer-data", staff, getCatererAnalytics);
router.patch("/:orderId/status", staff, updateOrderStatus);
router.delete("/:orderId", ownOrderOrStaff, deleteOrder);
router.post("/weekly-menu", staff, (req, res, next) => {
  req.body.createdBy = req.user.userId;
  next();
}, setWeeklyMenu);
router.post("/weekly-order", asSelf, createWeeklyOrder);
router.patch("/daily-order", asSelf, updateDailyOrder);

module.exports = router;
