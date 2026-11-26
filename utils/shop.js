// Shared helpers for the demo shop (cart, orders) used by React-products-master/Amazon.
const mongoose = require('mongoose');
const Products = require('../models/Products');
const Delivery = require('../models/Delivery');
const { BadRequestError, NotFoundError } = require('../errors');
const { isAdmin } = require('../middleware/auth');

const MAX_QUANTITY = 100;
const MAX_LINES = 100;

const isObjectId = (v) => (typeof v === 'string' || v instanceof mongoose.Types.ObjectId)
    && /^[a-f0-9]{24}$/i.test(String(v));

function checkQuantity(q) {
    const n = Number(q);
    if (!Number.isInteger(n) || n < 1 || n > MAX_QUANTITY) {
        throw new BadRequestError(`Quantity must be a whole number from 1 to ${MAX_QUANTITY}.`);
    }
    return n;
}

// Validates and normalises the products a client sends. Only known fields are kept,
// so nothing else (prices, owners, operators) can be smuggled in.
function cleanProducts(products, { requireDate = false } = {}) {
    if (!Array.isArray(products)) throw new BadRequestError('products must be an array.');
    if (products.length > MAX_LINES) throw new BadRequestError(`At most ${MAX_LINES} products.`);
    return products.map((p) => {
        if (!p || typeof p !== 'object') throw new BadRequestError('Each product must be an object.');
        const productId = String(p.productId ?? '');
        if (!isObjectId(productId)) throw new BadRequestError('Invalid productId.');
        const deliveryOptionId = String(p.deliveryOptionId ?? '1');
        if (!['1', '2', '3'].includes(deliveryOptionId)) throw new BadRequestError('Invalid deliveryOptionId.');
        const out = { productId, deliveryOptionId, quantity: checkQuantity(p.quantity) };
        if (p.dateOrdered !== undefined) out.dateOrdered = String(p.dateOrdered).slice(0, 64);
        else if (requireDate) throw new BadRequestError('dateOrdered is required.');
        return out;
    });
}

// Prices a list of cart lines with two queries in total (it used to be two queries per line).
async function priceLines(lines) {
    const productIds = [...new Set(lines.map((l) => String(l.productId)))];
    const optionIds = [...new Set(lines.map((l) => String(l.deliveryOptionId)))];
    const [products, options] = await Promise.all([
        Products.find({ _id: { $in: productIds } }).select('priceCents').lean(),
        Delivery.find({ deliveryOptionId: { $in: optionIds } }).select('deliveryOptionId priceCents deliveryDays').lean(),
    ]);
    const price = new Map(products.map((p) => [String(p._id), p.priceCents]));
    const delivery = new Map(options.map((o) => [String(o.deliveryOptionId), o]));
    let totalCartCents = 0;
    let totalDeliveryCents = 0;
    for (const l of lines) {
        const p = price.get(String(l.productId));
        if (p !== undefined) totalCartCents += p * l.quantity;
        const d = delivery.get(String(l.deliveryOptionId));
        if (d) totalDeliveryCents += d.priceCents;
    }
    return { totalCartCents, totalDeliveryCents, delivery };
}

async function repriceCart(cart) {
    if (!cart.products.length) {
        cart.totalCartCents = 0;
        cart.totalDeliveryCents = 0;
        return cart;
    }
    const { totalCartCents, totalDeliveryCents } = await priceLines(cart.products);
    cart.totalCartCents = totalCartCents;
    cart.totalDeliveryCents = totalDeliveryCents;
    return cart;
}

// Records with a createdBy belong to that user (or an admin). Records without one are
// the shared anonymous demo cart/orders the Amazon frontend uses before it has a login.
function canAccess(req, doc) {
    if (!doc.createdBy) return true;
    if (isAdmin(req)) return true;
    return !!req.user && String(doc.createdBy) === String(req.user.userId);
}

async function findOwned(Model, id, req, label) {
    if (!isObjectId(String(id))) throw new NotFoundError(`No ${label} with id ${id}`);
    const doc = await Model.findById(id);
    // 404 (not 403) so ids belonging to someone else can't be probed.
    if (!doc || !canAccess(req, doc)) throw new NotFoundError(`No ${label} with id ${id}`);
    return doc;
}

// Who may list: admin -> everything; signed in -> theirs; anonymous -> the demo records.
function ownerFilter(req) {
    if (isAdmin(req)) return {};
    if (req.user) return { createdBy: req.user.userId };
    return { createdBy: null };
}

// ?page=&limit= with a hard cap, so a list can never return the whole collection.
function pageParams(query, { defaultLimit = 100, maxLimit = 100 } = {}) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || defaultLimit, 1), maxLimit);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    return { limit, page, skip: (page - 1) * limit };
}

module.exports = {
    MAX_QUANTITY,
    isObjectId,
    checkQuantity,
    cleanProducts,
    priceLines,
    repriceCart,
    canAccess,
    findOwned,
    ownerFilter,
    pageParams,
};
