const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { optionalAuth } = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');

const { getAllOrders,
        createOrder,
        deleteOrder,
        updateOrder,
        getOrder
    } = require('../controllers/orders.js')

// Listing and placing orders work anonymously for the demo shop (anonymous callers only see
// anonymous orders); a token scopes them to that user. Editing/deleting orders is admin-only.
router.route('/').post(optionalAuth, createOrder).get(optionalAuth, getAllOrders)

router.route('/:id').get(optionalAuth, getOrder).delete(authMiddleware, adminOnly, deleteOrder).patch(authMiddleware, adminOnly, updateOrder)

module.exports = router;
