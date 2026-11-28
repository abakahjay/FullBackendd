const express = require('express');
const { ClerkExpressRequireAuth }= require("@clerk/clerk-sdk-node");
const {
    deleteChat,
    getUploadAuth,
    createChat,
    getUserChats,
    getChatById,
    updateChat,
    deleteMessage,
    searchChatsByTitle,
    editMessageInChat
} = require('../controllers/chatAi');
const authMiddleware = require('../middleware/auth');
const { requireSelf } = require('../middleware/auth');
const router = express.Router();

// GH-GPT's older chat routes carry the owner in the URL. They used to need no
// login, so anyone who knew a user id (public on every post) could read, edit or
// delete that user's chats. Now the caller must be signed in as that user.
const own = [authMiddleware, requireSelf('userId')];

router.post("/chats/:userId", own, createChat);//
router.get("/userchats/:userId", own, getUserChats);//
router.get("/userchats/:userId/search-by-similarity", own, searchChatsByTitle);
router.get("/chats/:userId/:chatId", own, getChatById);//
router.patch("/chats/:userId/:chatId", own, updateChat);//
router.delete('/chats/:userId/:chatId', own, deleteChat);//
router.delete('/chats/:userId/:chatId/:messageIndex', own, deleteMessage);
router.patch('/chats/:userId/:chatId/:messageIndex', own, editMessageInChat);


//This is for imagekit and clerk backend
// router.get("/upload", getUploadAuth);
// router.post("/chats", ClerkExpressRequireAuth(), createChat);
// router.get("/userchats", ClerkExpressRequireAuth(), getUserChats);
// router.get("/chats/:id", ClerkExpressRequireAuth(), getChatById);
// router.put("/chats/:id", ClerkExpressRequireAuth(), updateChat);
module.exports = router;