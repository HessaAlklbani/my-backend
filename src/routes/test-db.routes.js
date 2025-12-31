const express = require("express");
const router = express.Router();
const db = require("../config/db");

router.get("/test-db", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT 1");
    res.json({ success: true, message: "Database connected" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
