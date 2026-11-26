// Demo shop cart (React-products-master/Amazon). Routes: routes/cart.js, routes/cart2.js.
// Ownership: a cart with createdBy belongs to that user (or an admin); a cart without one is
// the shared anonymous demo cart the frontend uses while it has no login (utils/shop.js).
const { StatusCodes } = require('http-status-codes');
const dayJs = require('dayjs');
const Cart = require('../models/Cart');
const { BadRequestError, NotFoundError } = require('../errors');
const {
    cleanProducts, checkQuantity, repriceCart, findOwned, ownerFilter, pageParams,
} = require('../utils/shop');

const today = () => dayJs().format('ddd, D MMMM YYYY');
const sameId = (a, b) => String(a) === String(b);

// GET /api/v1/cart  (auth) admin: every cart; user: their own
const getAllCart = async (req, res) => {
    const { limit, skip } = pageParams(req.query);
    const carts = await Cart.find(ownerFilter(req)).sort('-createdAt').skip(skip).limit(limit);
    res.status(StatusCodes.OK).json({ msg: 'Get all Carts', nbHits: carts.length, carts });
};

// GET /api/v1/cart/:id
const getCart = async (req, res) => {
    const cart = await findOwned(Cart, req.params.id, req, 'cart');
    res.status(StatusCodes.OK).json({ msg: 'Cart Found', nbHits: 1, cart });
};

// POST /api/v1/cart  (auth) body: [{ products: [...] }] or { products: [...] }
const createCart = async (req, res) => {
    const body = Array.isArray(req.body) ? req.body[0] : req.body;
    const products = cleanProducts(body?.products ?? [], {}).map((p) => ({ ...p, dateOrdered: p.dateOrdered || today() }));
    const cart = new Cart({ products, totalCartCents: 0, totalDeliveryCents: 0, createdBy: req.user.userId });
    await repriceCart(cart);
    await cart.save();
    res.status(StatusCodes.CREATED).json({ msg: 'Cart Created', newCart: [cart] });
};

// DELETE /api/v1/cart/:id  (auth, owner or admin)
const deleteCart = async (req, res) => {
    const cart = await findOwned(Cart, req.params.id, req, 'cart');
    if (!cart.createdBy && req.user?.role !== 'admin') {
        throw new NotFoundError(`No cart with id ${req.params.id}`);
    }
    await cart.deleteOne();
    res.status(StatusCodes.OK).json({ msg: 'Cart Deleted' });
};

// PATCH /api/v1/cart/:id  body: { products: [{ productId, deliveryOptionId, dateOrdered, quantity }] }
// Adds the products; a product already in the cart has its quantity increased.
const updateCart = async (req, res) => {
    if (req.body?.products === undefined) {
        throw new BadRequestError('The products fields cannot be empty');
    }
    const incoming = cleanProducts(req.body.products);
    const cart = await findOwned(Cart, req.params.id, req, 'cart');
    const date = today();
    for (const p of incoming) {
        const line = cart.products.find((l) => sameId(l.productId, p.productId));
        if (line) {
            line.quantity = Math.min(line.quantity + p.quantity, 100);
            line.dateOrdered = date;
        } else {
            cart.products.unshift({ ...p, dateOrdered: p.dateOrdered || date });
        }
    }
    await repriceCart(cart);
    await cart.save();
    res.status(StatusCodes.OK).json({ msg: 'Cart updated by adding products to the cart', nbHits: cart.products.length, cart });
};

// PATCH /api/v1/cart/:id/:productId  removes one product
const deleteCartProduct = async (req, res) => {
    const { productId } = req.params;
    const cart = await findOwned(Cart, req.params.id, req, 'cart');
    const index = cart.products.findIndex((l) => sameId(l.productId, productId));
    if (index === -1) throw new NotFoundError(`There is no product with id ${productId}`);
    cart.products.splice(index, 1);
    await repriceCart(cart);
    await cart.save();
    res.status(StatusCodes.OK).json({ msg: 'Cart updated by deleting a product from the array', nbHits: cart.products.length, cart });
};

// PATCH /api/v1/cart/:id/:productId/:quantity
const changeCartQuantity = async (req, res) => {
    const { productId } = req.params;
    const quantity = checkQuantity(req.params.quantity);
    const cart = await findOwned(Cart, req.params.id, req, 'cart');
    const line = cart.products.find((l) => sameId(l.productId, productId));
    if (!line) throw new NotFoundError(`There is no product with id ${productId}`);
    line.quantity = quantity;
    await repriceCart(cart);
    await cart.save();
    res.status(StatusCodes.OK).json({ msg: 'Cart updated by changing a product quantity from the array', nbHits: cart.products.length, cart });
};

// PATCH /api/v1/changedel/:id/:productId/:option
const changeDelivery = async (req, res) => {
    const { productId, option } = req.params;
    if (!['1', '2', '3'].includes(String(option))) throw new BadRequestError('Invalid delivery option.');
    const cart = await findOwned(Cart, req.params.id, req, 'cart');
    const line = cart.products.find((l) => sameId(l.productId, productId));
    if (!line) throw new NotFoundError(`There is no product with id ${productId}`);
    line.deliveryOptionId = String(option);
    line.dateOrdered = today();
    await repriceCart(cart);
    await cart.save();
    res.status(StatusCodes.OK).json({ msg: 'Cart Updated by changing the delivery option and the date Ordered', cart });
};

// PATCH /api/v1/changedel/:id  empties the cart (after checkout)
const deleteAllCartProducts = async (req, res) => {
    const cart = await findOwned(Cart, req.params.id, req, 'cart');
    cart.products = [];
    await repriceCart(cart);
    await cart.save();
    res.status(StatusCodes.OK).json({ msg: 'Cart updated by deleting all the products from the array', nbHits: 0, cart });
};

module.exports = {
    getAllCart,
    createCart,
    deleteCart,
    updateCart,
    getCart,
    deleteCartProduct,
    changeCartQuantity,
    changeDelivery,
    deleteAllCartProducts,
};
