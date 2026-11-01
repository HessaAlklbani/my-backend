const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const upload = require("../middleware/upload");
const path = require("path");
const dashboardAuth = require("../middleware/dashboardAuth");

async function safelyQueueFiles(filenames) {
  try {
    await upload.scheduleFileCleanup(filenames);
  } catch (error) {
    console.error("Could not queue stored file cleanup", error.code || error.name || "QUEUE_ERROR");
    for (const filename of filenames || []) {
      await upload.deleteIfUnreferenced(filename).catch((deleteError) => {
        console.error("New unreferenced upload cleanup failed", deleteError.code || deleteError.name || "DELETE_FAILED");
      });
    }
  }
}

async function processCleanupQueue() {
  try {
    await upload.processFileCleanupQueue();
  } catch (error) {
    console.error("Stored file cleanup remains queued", error.code || error.name || "QUEUE_ERROR");
  }
}


/**
 * CREATE customer
 */
router.post("/", upload.single("eid"), async (req, res) => {
  const { full_name, phone, nationality } = req.body;
  const eid_file = req.file ? req.file.filename : null;

  if (!full_name || !String(full_name).trim() || !phone || !String(phone).trim()) {
    if (eid_file) await safelyQueueFiles([eid_file]);
    return res.status(400).json({ message: "Full name and phone are required" });
  }

  try {
    // Match names without regard to capitalization or surrounding whitespace.
    // Phone remains an exact match after trimming so distinct numbers stay distinct.
    const [existing] = await pool.query(
      `SELECT id FROM customers
       WHERE LOWER(TRIM(full_name)) = LOWER(TRIM(?))
         AND TRIM(phone) = TRIM(?)
       ORDER BY id ASC
       LIMIT 1`,
      [full_name, phone]
    );

    if (existing.length > 0) {
      if (eid_file) {
        await safelyQueueFiles([eid_file]);
        await processCleanupQueue();
      }
      return res.json({ customer_id: existing[0].id, existing: true });
    }

    const [result] = await pool.query(
      "INSERT INTO customers (full_name, phone, nationality, eid_file) VALUES (?, ?, ?, ?)",
      [full_name, phone, nationality, eid_file]
    );
    res.json({ customer_id: result.insertId, existing: false });
  } catch (err) {
    if (eid_file) await safelyQueueFiles([eid_file]);
    res.status(500).json({ error: err.message });
  }
});

/**
 * READ all customers
 */
router.get("/", dashboardAuth, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM customers");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Serve a customer's identity document only to an authenticated dashboard user.
 */
router.get("/:id/eid", dashboardAuth, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT eid_file FROM customers WHERE id = ? LIMIT 1", [req.params.id]);
    if (!rows.length || !rows[0].eid_file) {
      return res.status(404).json({ message: "Customer ID image not found" });
    }

    const filename = path.basename(rows[0].eid_file);
    if (filename !== rows[0].eid_file) return res.status(404).end();
    return await upload.sendStoredFile(filename, res);
  } catch (error) {
    console.error("Serve customer ID image error:", error);
    return res.status(error.statusCode || 500).json({ message: "Unable to load customer ID image" });
  }
});

/**
 * READ single customer by ID
 */
router.get("/:id", dashboardAuth, async (req, res) => {
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

  let connection;
  let transactionStarted = false;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;
    // جلب البيانات القديمة إذا ما تم رفع ملف جديد
    const [existing] = await connection.query("SELECT eid_file FROM customers WHERE id = ? FOR UPDATE", [id]);
    if (existing.length === 0) {
      await upload.enqueueFileCleanup(connection, eid_file ? [eid_file] : []);
      await connection.commit();
      transactionStarted = false;
      await processCleanupQueue();
      return res.status(404).json({ message: "Customer not found" });
    }

    const oldEidFile = existing[0].eid_file;
    const fileToUse = eid_file || existing[0].eid_file;

    await connection.query(
      "UPDATE customers SET full_name = ?, phone = ?, nationality = ?, eid_file = ? WHERE id = ?",
      [full_name, phone, nationality, fileToUse, id]
    );
    if (oldEidFile && oldEidFile !== fileToUse) {
      await upload.enqueueFileCleanup(connection, [oldEidFile]);
    }
    await connection.commit();
    transactionStarted = false;
    await processCleanupQueue();
    res.json({ message: "Customer updated successfully" });
  } catch (err) {
    if (transactionStarted && connection) await connection.rollback();
    if (eid_file) await safelyQueueFiles([eid_file]);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

/**
 * DELETE customer by ID
 */
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  const connection = await pool.getConnection();
  let transactionStarted = false;
  try {
    await connection.beginTransaction();
    transactionStarted = true;
    const [existing] = await connection.query("SELECT eid_file FROM customers WHERE id = ? FOR UPDATE", [id]);
    if (existing.length === 0) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(404).json({ message: "Customer not found" });
    }
    const [result] = await connection.query("DELETE FROM customers WHERE id = ?", [id]);
    await upload.enqueueFileCleanup(connection, [existing[0].eid_file]);
    await connection.commit();
    transactionStarted = false;
    if (result.affectedRows === 0) return res.status(404).json({ message: "Customer not found" });
    await processCleanupQueue();
    res.json({ message: "Customer deleted successfully" });
  } catch (err) {
    if (transactionStarted) await connection.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    connection.release();
  }
});

module.exports = router;
