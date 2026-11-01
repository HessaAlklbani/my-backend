const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const upload = require("../middleware/upload");

const fileCleanup = require("../middleware/fileCleanup");



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
    if (image) await fileCleanup.scheduleOrphanedUploads([image]);
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

  let connection;
  let transactionStarted = false;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const [existing] = await connection.query("SELECT image FROM services WHERE id = ? FOR UPDATE", [id]);
    if (existing.length === 0) {
      await connection.rollback();
      transactionStarted = false;
      if (req.file) await fileCleanup.scheduleOrphanedUploads([req.file.filename]);
      return res.status(404).json({ message: "Service not found" });
    }

    const oldImage = existing[0].image;
    const fileToUse = req.file ? req.file.filename : oldImage;

    await connection.query(
      "UPDATE services SET name = ?, description = ?, duration = ?, price = ?, image = ? WHERE id = ?",
      [name, description, duration, price, fileToUse, id]
    );

    if (oldImage && oldImage !== fileToUse) {
      await fileCleanup.enqueueFileCleanup(connection, [oldImage]);
    }
    await connection.commit();
    transactionStarted = false;
    await fileCleanup.processFileCleanupQueueSafely();

    res.json({ message: "Service updated successfully" });
  } catch (err) {
    if (transactionStarted && connection) await connection.rollback();
    if (req.file) await fileCleanup.scheduleOrphanedUploads([req.file.filename]);
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  } finally {
    if (connection) connection.release();
  }
});

// ================= DELETE SERVICE =================
router.delete("/:id", async (req, res) => {
  const { id } = req.params;

  const connection = await pool.getConnection();
  let transactionStarted = false;
  try {
    await connection.beginTransaction();
    transactionStarted = true;
    const [existing] = await connection.query("SELECT image FROM services WHERE id = ? FOR UPDATE", [id]);
    if (existing.length === 0) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(404).json({ message: "Service not found" });
    }

    await connection.query("DELETE FROM services WHERE id = ?", [id]);
    await fileCleanup.enqueueFileCleanup(connection, [existing[0].image]);
    await connection.commit();
    transactionStarted = false;
    await fileCleanup.processFileCleanupQueueSafely();
    res.json({ message: "Service deleted successfully" });
  } catch (err) {
    if (transactionStarted) await connection.rollback();
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  } finally {
    connection.release();
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
