const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const upload = require("../middleware/upload");

const fs = require("fs");
const path = require("path");



// ================= CREATE SERVICE =================
router.post("/", upload.single("image"), async (req, res) => {
  const { name, description, duration, price } = req.body;
  const image = req.file ? req.file.filename : null;

  try {
    const [result] = await pool.query(
      "INSERT INTO services (name, description, duration, price, image, active) VALUES (?, ?, ?, ?, ?, true)",
      [name, description, duration, price, image]
    );
    res.json({ service_id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/* =========================
   READ active services (catalog)
   (كودك الأصلي بدون تغيير)
========================= */
router.get("/", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, name, description, duration, price, image FROM services WHERE active = true"
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= READ ALL SERVICES =================
router.get("/all", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM services");
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ================= READ SINGLE SERVICE =================
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const [rows] = await pool.query("SELECT * FROM services WHERE id = ?", [id]);
    if (rows.length === 0) return res.status(404).json({ message: "Service not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ================= UPDATE SERVICE =================
router.put("/:id", upload.single("image"), async (req, res) => {
  const { id } = req.params;
  const { name, description, duration, price } = req.body;

  try {
    // جلب الصورة القديمة إذا ما تم رفع صورة جديدة
    const [existing] = await pool.query("SELECT image FROM services WHERE id = ?", [id]);
    if (existing.length === 0) return res.status(404).json({ message: "Service not found" });

    const fileToUse = req.file ? req.file.filename : existing[0].image;

    await pool.query(
      "UPDATE services SET name = ?, description = ?, duration = ?, price = ?, image = ? WHERE id = ?",
      [name, description, duration, price, fileToUse, id]
    );

    res.json({ message: "Service updated successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ================= DELETE SERVICE =================
router.delete("/:id", async (req, res) => {
  const { id } = req.params;

  try {
    // حذف الصورة من uploads
    const [existing] = await pool.query("SELECT image FROM services WHERE id = ?", [id]);
    if (existing.length === 0) return res.status(404).json({ message: "Service not found" });

    if (existing[0].image) {
      const filePath = path.join(__dirname, "..", "uploads", existing[0].image);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    await pool.query("DELETE FROM services WHERE id = ?", [id]);
    res.json({ message: "Service deleted successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ================= TOGGLE ACTIVE/INACTIVE =================
router.patch("/:id/toggle", async (req, res) => {
  const { id } = req.params;

  try {
    const [existing] = await pool.query("SELECT active FROM services WHERE id = ?", [id]);
    if (existing.length === 0) return res.status(404).json({ message: "Service not found" });

    const newStatus = existing[0].active ? 0 : 1;
    await pool.query("UPDATE services SET active = ? WHERE id = ?", [newStatus, id]);
    res.json({ message: "Service status updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

module.exports = router;
