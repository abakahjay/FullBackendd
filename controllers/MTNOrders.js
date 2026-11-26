const Orders = require('../models/MTNOrders');
const { BadRequestError, NotFoundError } = require('../errors');
const { StatusCodes } = require('http-status-codes');
const User = require('../models/User');

const STATUSES = ['Pending', 'Delivered', 'Failed'];
const str = (v, n = 200) => (v === undefined || v === null ? undefined : String(v).slice(0, n));

// ✅ GET all orders
const getAllOrders = async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 1000);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const orders = await Orders.find({}).sort('-createdAt').skip((page - 1) * limit).limit(limit);
  res.status(StatusCodes.OK).json(orders);
};

// ✅ GET a single order
const getOrder = async (req, res) => {
  const { id } = req.params;
  const order = await Orders.findById(id);
  if (!order) throw new NotFoundError(`No order with ID: ${id}`);
  res.status(StatusCodes.OK).json(order);
};

// ✅ CREATE a new order
const createOrder = async (req, res) => {
  const { recipient, quantity, network, price, payment, status, updated } = req.body;

  if (!recipient || !quantity || !network || !price) {
    throw new BadRequestError("All fields except 'updated' are required.");
  }

  // status/payment are never taken from a non-admin caller (they mark an order as paid/delivered).
  const admin = req.user?.role === 'admin';
  const order = await Orders.create({
    recipient: str(recipient, 40), quantity: str(quantity, 40), network: str(network, 40), price: str(price, 20),
    updated: str(updated, 64),
    ...(admin ? { payment: str(payment, 100), status: STATUSES.includes(status) ? status : 'Pending' } : {}),
  });
  res.status(StatusCodes.CREATED).json(order);
};

// ✅ UPDATE an order
const updateOrder = async (req, res) => {
  const { id } = req.params;
  const allowed = ['recipient', 'quantity', 'network', 'price', 'payment', 'status', 'updated', 'email', 'transactionId'];
  const update = {};
  for (const k of allowed) if (req.body?.[k] !== undefined) update[k] = str(req.body[k]);

  const order = await Orders.findByIdAndUpdate(id, update, {
    new: true,
    runValidators: true,
  });

  if (!order) throw new NotFoundError(`No order with ID: ${id}`);
  res.status(StatusCodes.OK).json(order);
};

// ✅ DELETE an order
const deleteOrder = async (req, res) => {
  const { id } = req.params;
  const order = await Orders.findByIdAndDelete(id);

  if (!order) throw new NotFoundError(`No order with ID: ${id}`);
  res.status(StatusCodes.OK).json({ msg: 'Order deleted' });
};

// ✅ UPDATE only the status of an order
const updateOrderStatus = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!status) {
    throw new BadRequestError("Status is required");
  }

  const order = await Orders.findByIdAndUpdate(
    id,
    { status },
    { new: true, runValidators: true }
  );

  if (!order) throw new NotFoundError(`No order with ID: ${id}`);
  res.status(StatusCodes.OK).json({ msg: "Status updated", updatedOrder: order });
};


// ✅ GET orders by email
const getOrdersByEmail = async (req, res) => {
  const { email } = req.params;

  if (!email) {
    throw new BadRequestError("Email parameter is required");
  }
  // GET /:email is also reached with an order id (the routes share the path).
  if (/^[a-f0-9]{24}$/i.test(email)) {
    if (req.user.role !== 'admin') throw new NotFoundError(`No order with ID: ${email}`);
    return getOrder(Object.assign(req, { params: { id: email } }), res);
  }

  // Signed-in users only see their own orders; admins can look anyone up.
  if (req.user.role !== 'admin') {
    const me = await User.findById(req.user.userId).select('email').lean();
    if (!me || String(me.email).toLowerCase() !== String(email).toLowerCase()) {
      throw new NotFoundError(`No orders found for email: ${email}`);
    }
  }

  const orders = await Orders.find({ email: String(email) }).sort('-createdAt').limit(500);

  if (!orders || orders.length === 0) {
    throw new NotFoundError(`No orders found for email: ${email}`);
  }

  res.status(StatusCodes.OK).json(orders);
};



module.exports = {
  getAllOrders,
  getOrder,
  createOrder,
  updateOrder,
  deleteOrder,
  updateOrderStatus,
  getOrdersByEmail
};
