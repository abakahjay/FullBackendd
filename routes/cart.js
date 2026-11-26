const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { optionalAuth } = require('../middleware/auth');

const {
    getAllCart,
    createCart,
    deleteCart,
    updateCart,
    getCart,
    deleteCartProduct,
    changeCartQuantity,
} = require('../controllers/cart.js')

// The Amazon demo frontend uses one anonymous cart without a login, so the per-cart routes take
// an optional token: a signed-in user only reaches their own carts (utils/shop.js canAccess).
// Listing every cart, creating and deleting carts need a token.
router.route('/').post(authMiddleware, createCart).get(authMiddleware, getAllCart)

router.route('/:id').get(optionalAuth, getCart).delete(authMiddleware, deleteCart).patch(optionalAuth, updateCart)

router.route('/:id/:productId').patch(optionalAuth, deleteCartProduct)

router.route('/:id/:productId/:quantity').patch(optionalAuth, changeCartQuantity)
module.exports = router;
