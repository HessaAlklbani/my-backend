const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const upload = require("../middleware/upload");


/**
 * CREATE customer
 */
router.post("/", upload.single("eid"), async (req, res) => {
  const { full_name, phone, nationality } = req.body;
  const eid_file = req.file ? req.file.filename : null;

  try {
    const [result] = await pool.query(
      "INSERT INTO customers (full_name, phone, nationality, eid_file) VALUES (?, ?, ?, ?)",
      [full_name, phone, nationality, eid_file]
    );
    res.json({ customer_id: result.insertId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * READ all customers
 */
router.get("/", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM customers");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * READ single customer by ID
 */
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const [rows] = await pool.query("SELECT * FROM customers WHERE id = ?", [id]);
    if (rows.length === 0) return res.status(404).json({ message: "Customer not found" });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * UPDATE customer by ID
 */
router.put("/:id", upload.single("eid"), async (req, res) => {
  const { id } = req.params;
  const { full_name, phone, nationality } = req.body;
  const eid_file = req.file ? req.file.filename : null;

  try {
    // جلب البيانات القديمة إذا ما تم رفع ملف جديد
    const [existing] = await pool.query("SELECT eid_file FROM customers WHERE id = ?", [id]);
    if (existing.length === 0) return res.status(404).json({ message: "Customer not found" });

    const fileToUse = eid_file || existing[0].eid_file;

    await pool.query(
      "UPDATE customers SET full_name = ?, phone = ?, nationality = ?, eid_file = ? WHERE id = ?",
      [full_name, phone, nationality, fileToUse, id]
    );
    res.json({ message: "Customer updated successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE customer by ID
 */
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const [result] = await pool.query("DELETE FROM customers WHERE id = ?", [id]);
    if (result.affectedRows === 0) return res.status(404).json({ message: "Customer not found" });
    res.json({ message: "Customer deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
