// routes/bundleRoutes.js
const express = require('express');
const authMiddleware = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const router = express.Router();
const controller = require('../controllers/bundleController');

router.get('/', controller.getBundles);        // GET all or filtered by ?network=MTN
// The price list: anyone could change or delete bundles. Admin only (no client writes).
router.post('/', authMiddleware, adminOnly, controller.createBundle);
router.put('/:id', authMiddleware, adminOnly, controller.updateBundle);
router.delete('/:id', authMiddleware, adminOnly, controller.deleteBundle);

module.exports = router;
