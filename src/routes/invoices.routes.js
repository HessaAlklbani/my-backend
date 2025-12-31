// routes/invoices.js
const express = require("express");
const router = express.Router();
const pool = require("../config/db");

/**
 * Create invoice + items
 */
router.post("/", async (req, res) => {
    const { customer_id, items, discount_type, discount_value } = req.body;

    const invoiceNumber = "INV-" + Date.now();
    let total = 0;
    items.forEach(i => total += i.price * i.quantity);

    let discountAmount = 0;
    if (discount_type === "PERCENT") discountAmount = (total * discount_value) / 100;
    else if (discount_type === "FIXED") discountAmount = discount_value;

    const finalTotal = total - discountAmount;

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const [invoiceRes] = await conn.query(
            `INSERT INTO invoices 
       (invoice_number, customer_id, total_amount, discount_type, discount_value, discount_amount)
       VALUES (?, ?, ?, ?, ?, ?)`,
            [invoiceNumber, customer_id, finalTotal, discount_type, discount_value, discountAmount]
        );

        const invoiceId = invoiceRes.insertId;

        for (let item of items) {
            await conn.query(
                `INSERT INTO invoice_items 
         (invoice_id, service_id, quantity, price)
         VALUES (?, ?, ?, ?)`,
                [invoiceId, item.service_id, item.quantity, item.price]
            );
        }

        await conn.commit();
        res.json({ invoice_id: invoiceId, invoice_number: invoiceNumber });
    } catch (err) {
        await conn.rollback();
        res.status(500).json({ error: err.message });
    } finally {
        conn.release();
    }
});

/**
 * GET invoice by ID
 */
router.get("/:id", async (req, res) => {
    try {
        const [invoiceRows] = await pool.query(
            `SELECT i.id, i.invoice_number, i.total_amount, i.discount_type, i.discount_value, i.discount_amount, i.created_at,
        c.full_name, c.phone, c.nationality
        FROM invoices i
        JOIN customers c ON i.customer_id = c.id
        WHERE i.id = ?`,
            [req.params.id]
        );

        console.log("Fetching invoice:", req.params.id);
        console.log("Invoice rows:", invoiceRows); // ✨ اضف هذا

        if (invoiceRows.length === 0)
            return res.status(404).json({ message: "Invoice not found" });

        const invoice = invoiceRows[0];

        const [items] = await pool.query(
            `SELECT ii.quantity, ii.price, s.name, s.duration
         FROM invoice_items ii
         JOIN services s ON ii.service_id = s.id
         WHERE ii.invoice_id = ?`,
            [req.params.id]
        );

        res.json({ invoice, items });
    } catch (err) {
        console.error("Error fetching invoice:", err); // ✨ اضف هذا
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET all invoices
 */
router.get("/", async (req, res) => {
    try {
      const [rows] = await pool.query(`
        SELECT i.id, i.invoice_number, i.total_amount, i.created_at,
               c.full_name
        FROM invoices i
        JOIN customers c ON i.customer_id = c.id
        ORDER BY i.created_at DESC
      `);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });


module.exports = router;
