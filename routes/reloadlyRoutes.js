// routes/reloadlyRoutes.js
const express = require('express');
const authMiddleware = require('../middleware/auth');
const router = express.Router();
const axios = require('axios');
const { getOperators, purchaseAirtime, getAccessToken } = require('../controllers/reloadlyController');

router.get('/operators', getOperators);
// Spends the Reloadly balance (sandbox today): signed-in users only. buydata.html sends
// the token cookie (same-origin fetch, behind htmlAuth).
router.post('/purchase', authMiddleware, purchaseAirtime);
router.get('/operators/:id/bundles', async (req, res) => {
    const operatorId = req.params.id;
    const token = await getAccessToken();

    const { data } = await axios.get(`https://topups-sandbox.reloadly.com/operators/${operatorId}/packages`
        , {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/com.reloadly.topups-v1+json',
            },
        });

    res.status(200).json(data);
});


module.exports = router;
