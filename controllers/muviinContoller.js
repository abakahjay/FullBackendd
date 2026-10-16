const axios = require("axios");
const crypto = require("crypto");

const MUVIIN_API_URL = "https://api.muviin.co/api/src/controllers/dev/index.php";
// Muviin API key lives in .env (MUVIIN_API_KEY), never in the code.
const MUVIIN_API_KEY = process.env.MUVIIN_API_KEY;

const initiateBundle = async (req, res) => {
    const {
        network,
        bundle,
        amount,
        number,
        fundsource,
        selectedFSNetwork,
    } = req.body;

    if (!network || !bundle || !amount || !number || !fundsource || !selectedFSNetwork) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    const formatNumber = (num) => {
        if (num.startsWith('0')) return '233' + num.slice(1);
        return num;
    };

    const extref = `vbundle_${crypto.randomUUID()}`;
    const payload = {
        type: 1,
        function: "data-init",
        network: String(network).toLowerCase(),              // Ensure lowercase
        bundle: String(bundle),
        amount: String(parseFloat(amount).toFixed(2)),       // Format as "10.00"
        number: formatNumber(number),
        fundsource: formatNumber(fundsource),
        selectedFSNetwork: String(selectedFSNetwork).toLowerCase(),
        extref,
    };

    console.log("📤 Payload to Muviin:", payload);

    try {
        const response = await axios.post(MUVIIN_API_URL, payload, {
            headers: {
                "Content-Type": "application/json",
                "Apikey": MUVIIN_API_KEY,
            },
        });

        console.log("✅ Muviin Response:", response.data);

        return res.status(200).json({
            message: "Muviin payment initiated successfully",
            data: response.data,
        });
    } catch (err) {
        if (err.response) {
            console.error("🔴 Muviin API Error:", err.response.data);
            return res.status(err.response.status).json({
                error: "Muviin rejected the request",
                detail: err.response.data,
            });
        }

        console.error("🔴 Unexpected Muviin Error:", err.message);
        return res.status(500).json({
            error: "Internal server error",
            detail: err.message,
        });
    }
};

module.exports = { initiateBundle };
