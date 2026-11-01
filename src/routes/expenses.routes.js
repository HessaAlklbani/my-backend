const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const upload = require("../middleware/upload");

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

const uploadExpenseReceipt = (req, res, next) => {
  upload.single("bill_image")(req, res, (error) => {
    if (!error) return next();
    return res.status(error.statusCode || (error.code === "LIMIT_FILE_SIZE" ? 413 : 400)).json({
      message: error.statusCode >= 500
        ? "Unable to store receipt image"
        : error.code === "LIMIT_FILE_SIZE"
        ? "Receipt image must be 10 MB or smaller"
        : error.message || "Unable to upload receipt image",
    });
  });
};

const VAT_TREATMENTS = new Set([
  "STANDARD", "ZERO_RATED", "EXEMPT", "OUT_OF_SCOPE", "NO_VAT", "UNKNOWN"
]);

function readVatFields(body) {
  const treatment = String(body.vat_treatment || "UNKNOWN").toUpperCase();
  if (!VAT_TREATMENTS.has(treatment)) throw new Error("Invalid VAT treatment");

  const optionalAmount = (value, label) => {
    if (value === undefined || value === null || value === "") return null;
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) throw new Error(`${label} must be a valid non-negative amount`);
    return amount;
  };

  const vatRate = optionalAmount(body.vat_rate, "VAT rate");
  const vatAmount = optionalAmount(body.vat_amount, "VAT amount");
  const netAmount = optionalAmount(body.expense_net_amount, "Net amount");
  const recoverableVat = optionalAmount(body.recoverable_vat_amount, "Recoverable VAT") ?? 0;
  if (vatRate !== null && vatRate > 100) throw new Error("VAT rate cannot exceed 100%");
  if (vatAmount !== null && recoverableVat > vatAmount) {
    throw new Error("Recoverable VAT cannot exceed the recorded VAT amount");
  }
  if (recoverableVat > 0 && vatAmount === null) {
    throw new Error("Enter the VAT amount before recording recoverable input VAT");
  }
  if (vatAmount !== null && netAmount === null) {
    throw new Error("Enter the net amount when recording VAT details");
  }
  if (vatAmount !== null && netAmount !== null && Math.abs(Number(body.amount) - netAmount - vatAmount) > 0.02) {
    throw new Error("Amount paid must match the net amount plus VAT");
  }
  if (recoverableVat > 0 && treatment !== "STANDARD") {
    throw new Error("Recoverable input VAT can only be recorded for standard-rated purchases");
  }

  const amountIncludesVat = body.amount_includes_vat === undefined || body.amount_includes_vat === ''
    ? null
    : body.amount_includes_vat === true || String(body.amount_includes_vat).toLowerCase() === 'true'
      ? 1
      : body.amount_includes_vat === false || String(body.amount_includes_vat).toLowerCase() === 'false'
        ? 0
        : null;
  if (body.amount_includes_vat !== undefined && body.amount_includes_vat !== '' && amountIncludesVat === null) {
    throw new Error('VAT included must be true, false, or left unrecorded');
  }
  if (amountIncludesVat === 1 && (vatAmount === null || netAmount === null)) {
    throw new Error('Enter the net amount and VAT amount shown on the receipt when VAT is included');
  }
  if (amountIncludesVat === 0 && vatAmount !== null && vatAmount > 0) {
    throw new Error('The amount is marked as excluding VAT but a positive VAT amount was entered');
  }

  return [
    body.supplier_name || null,
    body.supplier_trn || null,
    body.supplier_invoice_number || null,
    netAmount,
    vatRate,
    vatAmount,
    recoverableVat,
    treatment,
    amountIncludesVat
  ];
}

/* ================= GET ALL ================= */
router.get("/all", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM expenses ORDER BY expense_date DESC"
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json(err);
  }
});

/* ================= CREATE ================= */
router.post("/", uploadExpenseReceipt, async (req, res) => {
  const bill_image = req.file ? req.file.filename : null;
  try {
    const { title, amount, description, expense_date, created_by } = req.body;
    const vatFields = readVatFields(req.body);
    if (!title || amount === undefined || amount === null || String(amount).trim() === "" ||
        !Number.isFinite(Number(amount)) || Number(amount) < 0 || !expense_date) {
      if (bill_image) await safelyQueueFiles([bill_image]);
      return res.status(400).json({ message: "Title, valid amount, and expense date are required" });
    }
    const [result] = await pool.query(
      `INSERT INTO expenses 
       (title, amount, description, expense_date, created_by, bill_image,
        supplier_name, supplier_trn, supplier_invoice_number, expense_net_amount,
        vat_rate, vat_amount, recoverable_vat_amount, vat_treatment, amount_includes_vat)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [title, amount, description, expense_date, created_by, bill_image, ...vatFields]
    );

    res.json({ success: true, id: result.insertId });
  } catch (err) {
    if (bill_image) await safelyQueueFiles([bill_image]);
    const message = String(err.message || "Unable to save expense");
    res.status(message.startsWith("Invalid") || message.includes("amount") || message.includes("VAT")
      ? 400 : 500).json({ message });
  }
});

/* ================= UPDATE ================= */
router.put("/:id", uploadExpenseReceipt, async (req, res) => {
  const bill_image = req.file ? req.file.filename : null;
  let connection;
  let transactionStarted = false;
  try {
    const { title, amount, description, expense_date, created_by } = req.body;
    const vatFields = readVatFields(req.body);
    if (!title || amount === undefined || amount === null || String(amount).trim() === "" ||
        !Number.isFinite(Number(amount)) || Number(amount) < 0 || !expense_date) {
      if (bill_image) await safelyQueueFiles([bill_image]);
      return res.status(400).json({ message: "Title, valid amount, and expense date are required" });
    }
    connection = await pool.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;
    const [existing] = await connection.query(
      "SELECT bill_image FROM expenses WHERE id = ? FOR UPDATE",
      [req.params.id]
    );
    if (!existing.length) {
      await upload.enqueueFileCleanup(connection, bill_image ? [bill_image] : []);
      await connection.commit();
      transactionStarted = false;
      await processCleanupQueue();
      return res.status(404).json({ message: "Expense not found" });
    }
    const oldImage = existing[0].bill_image;

    let sql = `
      UPDATE expenses 
      SET title=?, amount=?, description=?, expense_date=?, created_by=?,
          supplier_name=?, supplier_trn=?, supplier_invoice_number=?, expense_net_amount=?,
          vat_rate=?, vat_amount=?, recoverable_vat_amount=?, vat_treatment=?, amount_includes_vat=?
    `;
    let params = [title, amount, description, expense_date, created_by, ...vatFields];

    if (bill_image) {
      sql += ", bill_image=?";
      params.push(bill_image);
    }

    sql += " WHERE id=?";
    params.push(req.params.id);

    await connection.query(sql, params);
    if (bill_image && oldImage && oldImage !== bill_image) {
      await upload.enqueueFileCleanup(connection, [oldImage]);
    }
    await connection.commit();
    transactionStarted = false;

    await processCleanupQueue();
    res.json({ success: true });
  } catch (err) {
    if (transactionStarted) await connection.rollback();
    if (bill_image) await safelyQueueFiles([bill_image]);
    const message = String(err.message || "Unable to update expense");
    res.status(message.startsWith("Invalid") || message.includes("amount") || message.includes("VAT")
      ? 400 : 500).json({ message });
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
      "SELECT bill_image FROM expenses WHERE id = ? FOR UPDATE",
      [req.params.id]
    );
    if (!existing.length) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(404).json({ message: "Expense not found" });
    }
    await connection.query("DELETE FROM expenses WHERE id = ?", [req.params.id]);
    await upload.enqueueFileCleanup(connection, [existing[0].bill_image]);
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
