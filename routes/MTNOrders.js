const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');

const {
  getAllOrders,
  createOrder,
  updateOrder,
  deleteOrder,
  updateOrderStatus,
  getOrdersByEmail,
} = require('../controllers/MTNOrders');

// Callers: static/afrodata.html (admin dashboard) and static/dashboard.html (a user's own orders).
// Both are same-origin pages behind htmlAuth, so the `token` cookie authenticates these fetches.
router.route('/').get(authMiddleware, adminOnly, getAllOrders).post(authMiddleware, createOrder);
// GET /:email returns that user's orders (own email only, unless admin); an order id also works here.
router.route('/:email').get(authMiddleware, getOrdersByEmail);
router.route('/:id').patch(authMiddleware, adminOnly, updateOrder).delete(authMiddleware, adminOnly, deleteOrder);
router.patch('/:id/status', authMiddleware, adminOnly, updateOrderStatus);

module.exports = router;
