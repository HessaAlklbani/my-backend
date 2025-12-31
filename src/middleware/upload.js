// middleware/upload.js
const multer = require("multer");

const storage = multer.diskStorage({
  destination: "uploads/",
  filename: (req, file, cb) => {
    // نحافظ على الاسم الأصلي، لكن نضيف رقم عشوائي أو timestamp قصير لتفادي التعارض
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + "-" + file.originalname);
  },
});

const upload = multer({ storage });

module.exports = upload;



