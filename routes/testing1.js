const express = require('express');
const adminOnly = require('../middleware/adminOnly');
const router = express.Router();
// const {StatusCodes}= require('http-status-codes');

const {uploadProfilePic} = require('../controllers/testing1.js');
const {upload}= require('../utils/storageMulter.js')
const authMiddleware = require('../middleware/auth.js');



const {
    uploadSingleFile,
    uploadMultipleFiles,
    downloadFileById,
    downloadFilesAsZip,
    downloadFilesAsBase64,
    renameFile,
    deleteFile,
} = require("../controllers/testing1.js");

// Upload File to my customized Dashboard
router.route('/upload-profile-pic').patch(authMiddleware ,upload().single('profile_pictures'),uploadProfilePic )


// Upload routes
// Raw GridFS tools on the shared 'uploads' bucket (Nsoro media, voice notes, GH-GPT images).
// They were open: anyone could upload, rename or delete any file. Admin only; no app uses them.
router.post("/upload/single", authMiddleware, adminOnly, upload().single("file"), uploadSingleFile);
router.post("/upload/multiple", authMiddleware, adminOnly, upload().array("files"), uploadMultipleFiles);

// Download routes
router.get("/download/:fileId", downloadFileById);
router.get("/download/zip", downloadFilesAsZip);
router.get("/download/base64", downloadFilesAsBase64);

// File operations
router.put("/rename/:fileId", authMiddleware, adminOnly, renameFile);
router.delete("/delete/:fileId", authMiddleware, adminOnly, deleteFile);



module.exports=router;