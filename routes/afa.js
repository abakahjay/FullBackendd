const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');

const {
  registerAFA,
  getAllAFA,
  deleteAFA,
  updateAFA,
} = require('../controllers/afacontroller');

// Registering is public (static/afrohome.html). The list holds people's ID and phone numbers,
// so reading and changing it is admin-only (static/afrodata.html sends the `token` cookie).
router.post('/register', registerAFA);
router.get('/registrations', authMiddleware, adminOnly, getAllAFA);
router.put('/registrations/:id', authMiddleware, adminOnly, updateAFA);
router.delete('/registrations/:id', authMiddleware, adminOnly, deleteAFA);

module.exports = router;
