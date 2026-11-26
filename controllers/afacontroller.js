const AFARegistration = require('../models/AFAResgistration.js');
const { StatusCodes } = require('http-status-codes');
const { BadRequestError, NotFoundError } = require('../errors');

const FIELDS = ['fullname', 'idnumber', 'dob', 'phone', 'location', 'region', 'occupation'];
// Strings only (no Mongo operators), trimmed and length-capped.
const pick = (body) => {
  const out = {};
  for (const k of FIELDS) if (body?.[k] !== undefined && body[k] !== null) out[k] = String(body[k]).trim().slice(0, 120);
  return out;
};

// POST: Create new registration
const registerAFA = async (req, res) => {
  // Never log req.body here: it holds ID numbers and phone numbers.
  const data = pick(req.body);
  if (FIELDS.some((k) => !data[k])) {
    throw new BadRequestError('All fields are required');
  }

  const newAFA = await AFARegistration.create(data);

  res.status(StatusCodes.CREATED).json({
    message: 'Registration successful',
    data: newAFA,
  });
};

// GET: All registrations
const getAllAFA = async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 1000, 1), 1000);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const registrations = await AFARegistration.find().sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit);
  res.status(StatusCodes.OK).json({ count: registrations.length, data: registrations });
};

// DELETE: One registration by ID
const deleteAFA = async (req, res) => {
  const { id } = req.params;

  const deleted = await AFARegistration.findByIdAndDelete(id);
  if (!deleted) {
    throw new NotFoundError(`No registration found with ID: ${id}`);
  }

  res.status(StatusCodes.OK).json({ message: 'Registration deleted successfully' });
};

// PUT: Update registration by ID
const updateAFA = async (req, res) => {
  const { id } = req.params;
  const updates = pick(req.body);

  const updated = await AFARegistration.findByIdAndUpdate(id, updates, { new: true, runValidators: true });
  if (!updated) {
    throw new NotFoundError(`No registration found with ID: ${id}`);
  }

  res.status(StatusCodes.OK).json({ message: 'Registration updated successfully', data: updated });
};

module.exports = {
  registerAFA,
  getAllAFA,
  deleteAFA,
  updateAFA,
};
