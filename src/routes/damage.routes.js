const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const upload = require("../middleware/upload");

function imageKeys(value) {
  return String(value || "").split(",").map((key) => key.trim()).filter(Boolean);
}

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

const uploadDamageImages = (req, res, next) => {
  upload.array("damage_images", 5)(req, res, (error) => {
    if (!error) return next();
    const status = error.statusCode || (error.code === "LIMIT_FILE_SIZE" ? 413 : 400);
    return res.status(status).json({
      message: status >= 500
        ? "Unable to store damage photos"
        : error.code === "LIMIT_FILE_SIZE"
        ? "Each damage image must be 10 MB or smaller"
        : error.message || "Unable to upload damage images",
    });
  });
};

/* ================= GET ALL ================= */
router.get("/all", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM damage_bills ORDER BY incident_date DESC"
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json(err);
  }
});

/* ================= MARK PAYMENT ================= */
router.patch('/:id/payment', async (req, res) => {
  const paymentStatus = String(req.body?.payment_status || '').toUpperCase();
  if (!['PAID', 'UNPAID'].includes(paymentStatus)) {
    return res.status(400).json({ message: 'payment_status must be PAID or UNPAID' });
  }

  try {
    const [existing] = await pool.query(
      'SELECT id FROM damage_bills WHERE id = ? LIMIT 1',
      [req.params.id]
    );
    if (!existing.length) {
      return res.status(404).json({ message: 'Damage bill not found' });
    }

    await pool.query(
      `UPDATE damage_bills
       SET payment_status = ?,
           paid_at = CASE WHEN ? = 'PAID' THEN CURRENT_TIMESTAMP ELSE NULL END
       WHERE id = ?`,
      [paymentStatus, paymentStatus, req.params.id]
    );

    const [rows] = await pool.query(
      'SELECT id, payment_status, paid_at FROM damage_bills WHERE id = ? LIMIT 1',
      [req.params.id]
    );
    return res.json({ success: true, ...rows[0] });
  } catch (err) {
    console.error('Update damage bill payment error:', err);
    return res.status(500).json({ message: 'Unable to update damage bill payment status' });
  }
});
/* ================= GET BY ID ================= */
router.get("/:id", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM damage_bills WHERE id = ? LIMIT 1",
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Damage bill not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json(err);
  }
});


/* ================= CREATE ================= */
router.post("/", uploadDamageImages, async (req, res) => {
  try {
    const {
      customer_name,
      customer_number,
      service_name,
      description,
      amount,
      incident_date,
      created_by,
    } = req.body;

    const damage_images = req.files?.length
      ? req.files.map(f => f.filename).join(",")
      : null;

    await pool.query(
      `INSERT INTO damage_bills
       (customer_name, customer_number, service_name, description, amount, damage_images, incident_date, created_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        customer_name,
        customer_number,
        service_name,
        description,
        amount,
        damage_images,
        incident_date,
        created_by,
      ]
    );

    res.json({ success: true });
  } catch (err) {
    if (req.files?.length) await safelyQueueFiles(req.files.map((file) => file.filename));
    res.status(500).json(err);
  }
});

/* ================= UPDATE ================= */
router.put("/:id", uploadDamageImages, async (req, res) => {
  let connection;
  let transactionStarted = false;
  try {
    connection = await pool.getConnection();
    const {
      customer_name,
      customer_number,
      service_name,
      description,
      amount,
      incident_date,
      created_by,
    } = req.body;

    await connection.beginTransaction();
    transactionStarted = true;
    const [existing] = await connection.query(
      "SELECT damage_images FROM damage_bills WHERE id = ? FOR UPDATE",
      [req.params.id]
    );
    if (!existing.length) {
      await upload.enqueueFileCleanup(connection, (req.files || []).map((file) => file.filename));
      await connection.commit();
      transactionStarted = false;
      await processCleanupQueue();
      return res.status(404).json({ message: "Damage report not found" });
    }

    let sql = `
      UPDATE damage_bills SET
        customer_name=?,
        customer_number=?,
        service_name=?,
        description=?,
        amount=?,
        incident_date=?,
        created_by=?
    `;

    const params = [
      customer_name,
      customer_number,
      service_name,
      description,
      amount,
      incident_date,
      created_by,
    ];

    if (req.files && req.files.length > 0) {
      sql += ", damage_images=?";
      params.push(req.files.map(f => f.filename).join(","));
    }

    sql += " WHERE id=?";
    params.push(req.params.id);

    await connection.query(sql, params);
    if (req.files?.length) {
      await upload.enqueueFileCleanup(connection, imageKeys(existing[0].damage_images));
    }
    await connection.commit();
    transactionStarted = false;

    await processCleanupQueue();
    res.json({ success: true });
  } catch (err) {
    if (transactionStarted && connection) await connection.rollback();
    if (req.files?.length) await safelyQueueFiles(req.files.map((file) => file.filename));
    res.status(500).json(err);
  } finally {
    if (connection) connection.release();
  }
});

/* ================= DELETE ================= */
router.delete("/:id", async (req, res) => {
  const connection = await pool.getConnection();
  let transactionStarted = false;
  try {
    await connection.beginTransaction();
    transactionStarted = true;
    const [existing] = await connection.query(
      "SELECT damage_images FROM damage_bills WHERE id = ? FOR UPDATE",
      [req.params.id]
    );
    if (!existing.length) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(404).json({ message: "Damage report not found" });
    }
    await connection.query("DELETE FROM damage_bills WHERE id = ?", [req.params.id]);
    await upload.enqueueFileCleanup(connection, imageKeys(existing[0].damage_images));
    await connection.commit();
    transactionStarted = false;
    await processCleanupQueue();
    res.json({ success: true });
  } catch (err) {
    if (transactionStarted) await connection.rollback();
    res.status(500).json(err);
  } finally {
    connection.release();
  }
});

module.exports = router;
