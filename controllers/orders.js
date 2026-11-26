// Demo shop orders (React-products-master/Amazon). Same ownership rules as the cart (utils/shop.js).
const { StatusCodes } = require('http-status-codes');
const dayJs = require('dayjs');
const Orders = require('../models/Orders');
const Delivery = require('../models/Delivery');
const { BadRequestError, NotFoundError } = require('../errors');
const { cleanProducts, findOwned, ownerFilter, pageParams } = require('../utils/shop');
const { isAdmin } = require('../middleware/auth');

// The orders collection also holds old records from other apps (SeedBridge-era buyer/farmer
// orders with addresses and payment references, no createdBy). Shop orders always have an
// orderTime, so non-admins only ever see those.
const SHOP_ONLY = { orderTime: { $exists: true } };
const shopFilter = (req) => (isAdmin(req) ? {} : { ...ownerFilter(req), ...SHOP_ONLY });
const findShopOrder = async (req) => {
    const order = await findOwned(Orders, req.params.id, req, 'order');
    if (!isAdmin(req) && !order.orderTime) throw new NotFoundError(`No order with id ${req.params.id}`);
    return order;
};

// GET /api/v1/orders  admin: all; signed in: theirs; anonymous: the demo orders. ?page=&limit= (max 100)
const getAllOrders = async (req, res) => {
    const { limit, skip } = pageParams(req.query);
    const orders = await Orders.find(shopFilter(req)).sort('-createdAt').skip(skip).limit(limit);
    res.status(StatusCodes.OK).json({ msg: 'Get all Orders', nbHits: orders.length, orders });
};

// GET /api/v1/orders/:id
const getOrder = async (req, res) => {
    const order = await findShopOrder(req);
    res.status(StatusCodes.OK).json({ msg: 'Order Found', nbHits: 1, order });
};

function checkTotal(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1e9) throw new BadRequestError('totalCostCents must be a non-negative number.');
    return Math.round(n);
}

// POST /api/v1/orders  body: [{ orderTime, totalCostCents, products }]
// Orders placed on the same day (orderTime) by the same owner are merged into one order.
const createOrder = async (req, res) => {
    const body = Array.isArray(req.body) ? req.body[0] : req.body;
    if (!body || typeof body !== 'object') throw new BadRequestError('Send [{ orderTime, totalCostCents, products }].');
    const orderTime = String(body.orderTime ?? '').slice(0, 64);
    if (!orderTime) throw new BadRequestError('orderTime is required.');
    const totalCostCents = checkTotal(body.totalCostCents);
    const products = cleanProducts(body.products ?? []);
    if (!products.length) throw new BadRequestError('The order has no products.');

    // Delivery dates are computed per request (they used to be frozen at server start).
    const options = await Delivery.find({ deliveryOptionId: { $in: [...new Set(products.map((p) => p.deliveryOptionId))] } }).lean();
    const days = new Map(options.map((o) => [String(o.deliveryOptionId), o.deliveryDays]));
    const now = dayJs();
    for (const p of products) {
        p.estimatedDeliveryTime = now.add(days.get(p.deliveryOptionId) ?? 7, 'day').format('ddd, D MMMM YYYY');
        delete p.dateOrdered;
    }

    const createdBy = req.user ? req.user.userId : null;
    // One indexed lookup instead of loading every order (models/Orders.js index).
    let order = await Orders.findOne({ orderTime, createdBy });
    if (order) {
        order.totalCostCents += totalCostCents;
        for (const p of products) {
            const existing = order.products.find((l) => String(l.productId) === String(p.productId));
            if (existing) existing.quantity += p.quantity;
            else order.products.unshift(p);
        }
        await order.save();
    } else {
        order = await Orders.create({ orderTime, totalCostCents, products, ...(createdBy ? { createdBy } : {}) });
    }
    res.status(StatusCodes.CREATED).json({ msg: 'Order Created', newOrder: order });
};

// DELETE /api/v1/orders/:id  (admin)
const deleteOrder = async (req, res) => {
    const order = await findOwned(Orders, req.params.id, req, 'order');
    await order.deleteOne();
    res.status(StatusCodes.OK).json({ msg: 'Order Deleted' });
};

// PATCH /api/v1/orders/:id  (admin) body: { totalCostCents, products }
const updateOrder = async (req, res) => {
    if (req.body?.products === undefined) {
        throw new BadRequestError('The products fields cannot be empty');
    }
    const products = cleanProducts(req.body.products);
    const order = await findOwned(Orders, req.params.id, req, 'order');
    if (req.body.totalCostCents !== undefined) order.totalCostCents = checkTotal(req.body.totalCostCents);
    const when = dayJs().add(7, 'day').format('ddd, D MMMM YYYY');
    for (const p of products) {
        delete p.dateOrdered;
        order.products.unshift({ ...p, estimatedDeliveryTime: when });
    }
    await order.save();
    res.status(StatusCodes.OK).json({ msg: 'Order updated', nbHits: order.products.length, order });
};

module.exports = { getAllOrders, createOrder, createOrders: createOrder, deleteOrder, updateOrder, getOrder };
