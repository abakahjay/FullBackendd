const express = require('express');
const router = express.Router();
const { optionalAuth } = require('../middleware/auth');

const {
    changeDelivery,
    deleteAllCartProducts
} = require('../controllers/cart.js')

// Mounted at /api/v1/changedel. Same ownership rules as routes/cart.js.
router.route('/:id').patch(optionalAuth, deleteAllCartProducts)
router.route('/:id/:productId/:option').patch(optionalAuth, changeDelivery)

module.exports = router;
