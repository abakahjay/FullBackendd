const express = require('express');
const { addComment,deleteComment,getPostComments } = require('../controllers/commentController');

const authMiddleware = require('../middleware/auth');
const { asSelfQuery, asSelfBody, selfUsername, ownPostFile, ownComment } = require('../middleware/legacySocialGuards');
const router = express.Router();

router.post('/:postId', authMiddleware, asSelfBody, addComment);
router.delete('/:postId', authMiddleware, ownComment, deleteComment);
router.get('/:postId', getPostComments);

module.exports = router;
