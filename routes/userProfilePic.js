const express = require('express');
const {upload}= require('../utils/storageMulter.js')
const { editUserProfilePic } = require('../controllers/userController');

const authMiddleware = require('../middleware/auth');
const { selfUsername } = require('../middleware/legacySocialGuards');
const router = express.Router();

// Your own photo only; sign-in is checked before the upload is streamed in.
router.patch('/:username/editUserProfile', authMiddleware, selfUsername, upload().single('profile_pictures'), editUserProfilePic);

module.exports = router;
