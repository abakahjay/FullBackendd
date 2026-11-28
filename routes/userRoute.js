const express = require('express');
const {upload}= require('../utils/storageMulter.js')
const { followUser, unfollowUser, getUser,getUserByName,editUser,getAllUsers,deleteUser,searchUsers } = require('../controllers/userController');
const authenticationMiddleware = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
// authenticationMiddleware, adminOnly, 
const { requireSelf, optionalAuth } = require('../middleware/auth');
const { asSelfQuery, asSelfBody, selfUsername, ownPostFile, ownComment } = require('../middleware/legacySocialGuards');
const router = express.Router();

router.delete('/:id',authenticationMiddleware, adminOnly,  deleteUser);

// :id is the follower (the caller), body.userId the person followed.
router.patch('/:id/follow', authenticationMiddleware, requireSelf('id'), followUser);
router.patch('/:id/unfollow', authenticationMiddleware, requireSelf('id'), unfollowUser);
router.get('/search', searchUsers); // must stay above '/:id'
router.get('/:id', optionalAuth, getUser); // email/phone only for the owner or an admin
router.get('/',getAllUsers);
router.patch('/:username', optionalAuth, getUserByName);
// Was open: anyone could change anyone's email, then reset the password.
router.patch('/:username/editUser', authenticationMiddleware, selfUsername, editUser);

module.exports = router;
