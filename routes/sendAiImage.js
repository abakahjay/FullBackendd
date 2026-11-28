const express = require('express');
const { ClerkExpressRequireAuth }= require("@clerk/clerk-sdk-node");
const {
    postImage,
    getImage ,
    deleteImage,
    
} = require('../controllers/chatAi');
const {upload} = require('../utils/storageMulter');
const authMiddleware = require('../middleware/auth');
const { requireSelf } = require('../middleware/auth');
const router = express.Router();

// Sign-in is checked before multer so anonymous uploads are never streamed in.
router.route('/upload/:userId/:chatId').post(authMiddleware, requireSelf('userId'), upload().single('file'), postImage);
// Public: <img src> can't send a header. GridFS ids are hard to guess but not secret;
// a short-lived signed link (like CropGuard's) would be stronger.
router.get('/image/:id', getImage);
router.delete('/chats/image/:chatId/:fileId', authMiddleware, deleteImage);


module.exports = router;