const express = require("express");
const router = express.Router();
const pool = require("../config/db");

/**
 * CREATE a review
 */
router.post("/", async (req, res) => {
  const { full_name, message , phone_number} = req.body;

  try {
    const [result] = await pool.query(
      "INSERT INTO reviews (full_name, message, phone_number) VALUES (?, ?, ?)",
      [full_name, message, phone_number]
    );
    res.json({ review_id: result.insertId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * READ all reviews
 */
router.get("/", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, full_name, message, phone_number, created_at FROM reviews ORDER BY created_at DESC"
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * READ single review by ID
 */
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const [rows] = await pool.query(
      "SELECT id, full_name, message, phone_number, created_at FROM reviews WHERE id = ?",
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Review not found" });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * UPDATE review by ID
 */
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const { full_name, message } = req.body;

  try {
    const [existing] = await pool.query("SELECT id FROM reviews WHERE id = ?", [id]);
    if (existing.length === 0) return res.status(404).json({ message: "Review not found" });

    await pool.query(
      "UPDATE reviews SET full_name = ?, message = ?, phone_number = ? WHERE id = ?",
      [full_name, message, id]
    );
    res.json({ message: "Review updated successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE review by ID
 */
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const [result] = await pool.query("DELETE FROM reviews WHERE id = ?", [id]);
    if (result.affectedRows === 0) return res.status(404).json({ message: "Review not found" });
    res.json({ message: "Review deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
