const express = require('express');
const { createPost, getPosts, getImage, getMedia ,deletePost,getUserPosts,likePosts,unlikePosts,getLikedPosts,getSavedPosts,toggleSavePost,getPost} = require('../controllers/postController');
const {postUpload} = require('../utils/storageMulter');
const authMiddleware = require('../middleware/auth');

const { asSelfQuery, asSelfBody, selfUsername, ownPostFile, ownComment } = require('../middleware/legacySocialGuards');
const router = express.Router();

// Sign-in before multer: anonymous uploads are never streamed in. The post is yours.
router.route('/').post(authMiddleware, asSelfQuery, postUpload('file'), createPost);
router.get('/', getPosts);
router.get('/saved', authMiddleware, getSavedPosts);
router.get('/user/:id', getUserPosts);
router.get('/liked/:id', getLikedPosts);
router.get('/image/:id', getImage);
// Streams images and videos inline with HTTP Range support, so <video> can seek.
router.get('/media/:id', getMedia);
router.delete('/image/:fileId', authMiddleware, ownPostFile, deletePost);
router.patch('/:postId/like', authMiddleware, asSelfBody, likePosts);
router.patch('/:postId/unlike', authMiddleware, asSelfBody, unlikePosts);
router.patch('/:postId/save', authMiddleware, toggleSavePost);
// Single post (share links /p/:postId). Keep last: '/:postId' would shadow '/saved'.
router.get('/:postId', getPost);

module.exports = router;
