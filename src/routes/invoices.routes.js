
const express = require("express");
const router = express.Router();
const pool = require("../config/db");

const VAT_RATE = 0.05;

function parseDurationMinutes(duration) {
    const value = String(duration || "").toLowerCase();

    const hours = value.match(
        /(\d+(?:\.\d+)?)\s*(hours?|hrs?|hores?|h)\b/
    );

    const minutes = value.match(
        /(\d+(?:\.\d+)?)\s*(minutes?|mins?|minuties|m)\b/
    );

    let total = 0;

    if (hours) total += Number(hours[1]) * 60;
    if (minutes) total += Number(minutes[1]);

    if (total === 0) {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric > 0) {
            total = numeric;
        }
    }

    return Math.round(total);
}

/**
 * Validate a local datetime string.
 *
 * Expected format:
 * YYYY-MM-DDTHH:mm
 * YYYY-MM-DDTHH:mm:ss
 *
 * The database stores local DATETIME values.
 */
function normalizeDateTime(value) {
    if (typeof value !== "string") {
        throw new Error("Scheduled start time must be a string");
    }

    const normalized = value.trim().replace("T", " ");

    if (
        !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(normalized)
    ) {
        throw new Error(
            "Invalid datetime. Use YYYY-MM-DDTHH:mm:ss"
        );
    }

    const finalValue =
        normalized.length === 16
            ? `${normalized}:00`
            : normalized;

    const date = new Date(finalValue.replace(" ", "T"));

    if (Number.isNaN(date.getTime())) {
        throw new Error("Invalid scheduled start date");
    }

    // Prevent impossible calendar dates.
    const [datePart, timePart] = finalValue.split(" ");
    const [year, month, day] = datePart.split("-").map(Number);
    const [hour, minute, second] = timePart.split(":").map(Number);

    const check = new Date(
        Date.UTC(year, month - 1, day, hour, minute, second)
    );

    if (
        check.getUTCFullYear() !== year ||
        check.getUTCMonth() !== month - 1 ||
        check.getUTCDate() !== day ||
        check.getUTCHours() !== hour ||
        check.getUTCMinutes() !== minute ||
        check.getUTCSeconds() !== second
    ) {
        throw new Error("Invalid calendar date or time");
    }

    return finalValue;
}

/**
 * Add minutes to a MySQL local datetime.
 * Avoids depending on the server timezone.
 */
function addMinutesToDateTime(dateTime, minutes) {
    const [datePart, timePart] = dateTime.split(" ");

    const [year, month, day] = datePart.split("-").map(Number);
    const [hour, minute, second] = timePart.split(":").map(Number);

    const date = new Date(
        Date.UTC(year, month - 1, day, hour, minute, second)
    );

    date.setUTCMinutes(date.getUTCMinutes() + minutes);

    const pad = value => String(value).padStart(2, "0");

    return (
        `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
        `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
    );
}

/**
 * Safe numeric conversion.
 */
function toNumber(value, fieldName) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        throw new Error(`${fieldName} must be a valid number`);
    }

    return number;
}

/**
 * Create invoice + items + scheduled service sessions.
 *
 * Existing checkout requests remain supported.
 */
router.post("/", async (req, res) => {
    const {
        customer_id,
        items,
        discount_type,
        discount_value,
        payment_type,
        staff_name
    } = req.body;


    if (!customer_id) {
        return res.status(400).json({
            message: "Customer ID is required"
        });
    }

    if (!staff_name || !String(staff_name).trim()) {
        return res.status(400).json({
            message: "Staff name is required"
        });
    }

    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({
            message: "Invoice items are required"
        });
    }

    const safePaymentType = payment_type || "CASH";

    const allowedPaymentTypes = [
        "CASH",
        "MACHINE",
        "BANK_TRANSFER"
    ];

    if (!allowedPaymentTypes.includes(safePaymentType)) {
        return res.status(400).json({
            message: "Invalid payment type"
        });
    }

    if (
        discount_type &&
        !["PERCENT", "FIXED"].includes(discount_type)
    ) {
        return res.status(400).json({
            message: "Invalid discount type"
        });
    }

    let total = 0;
    let discountAmount = 0;

    try {
        for (const item of items) {
            const quantity = toNumber(item.quantity, "Quantity");
            const price = toNumber(item.price, "Price");

            if (
                !Number.isInteger(quantity) ||
                quantity <= 0 ||
                price < 0 ||
                !item.service_id
            ) {
                return res.status(400).json({
                    message: "Invalid invoice item"
                });
            }

            total += price * quantity;
        }

        const discountValue = discount_value == null
            ? 0
            : toNumber(discount_value, "Discount value");

        if (discountValue < 0) {
            return res.status(400).json({
                message: "Discount cannot be negative"
            });
        }

        if (discount_type === "PERCENT") {
            if (discountValue > 100) {
                return res.status(400).json({
                    message: "Percentage discount cannot exceed 100%"
                });
            }

            discountAmount = (total * discountValue) / 100;
        } else if (discount_type === "FIXED") {
            discountAmount = discountValue;
        }

        if (discountAmount > total) {
            return res.status(400).json({
                message: "Discount cannot exceed invoice subtotal"
            });
        }

        discountAmount = Number(discountAmount.toFixed(2));

        const discountedTotal = Math.max(
            total - discountAmount,
            0
        );

        const vatAmount = Number(
            (discountedTotal * VAT_RATE).toFixed(2)
        );

        const grandTotal = Number(
            (discountedTotal + vatAmount).toFixed(2)
        );

        const invoiceNumber = "INV-" + Date.now();

        const conn = await pool.getConnection();

        try {
            await conn.beginTransaction();

            // Validate customer.
            const [customerRows] = await conn.query(
                "SELECT id FROM customers WHERE id = ?",
                [customer_id]
            );

            if (customerRows.length === 0) {
                throw new Error("Customer not found");
            }

            // Count one visit for each successfully created invoice. This is in
            // the same transaction so a failed invoice does not increment it.
            await conn.query(
                "UPDATE customers SET No_visit = COALESCE(No_visit, 0) + 1 WHERE id = ?",
                [customer_id]
            );

            // Create invoice.
            const [invoiceRes] = await conn.query(
                `INSERT INTO invoices
                (
                    invoice_number,
                    customer_id,
                    staff_name,
                    total_amount,
                    payment_type,
                    discount_type,
                    discount_value,
                    discount_amount
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    invoiceNumber,
                    customer_id,
                    staff_name,
                    grandTotal,
                    safePaymentType,
                    discount_type || null,
                    discount_type ? discountValue : null,
                    discountAmount
                ]
            );

            const invoiceId = invoiceRes.insertId;

            const createdItems = [];
            const createdSessions = [];

            for (const item of items) {
                const quantity = Number(item.quantity);
                const price = Number(item.price);

                // Validate service and obtain its actual duration.
                const [serviceRows] = await conn.query(
                    `SELECT id, name, duration, price
                        FROM services
                        WHERE id = ? AND active = 1`,
                    [item.service_id]
                );

                if (serviceRows.length === 0) {
                    throw new Error(
                        `Service ${item.service_id} not found or inactive`
                    );
                }

                const service = serviceRows[0];

                // Create invoice item.
                const [itemRes] = await conn.query(
                    `INSERT INTO invoice_items
                    (
                        invoice_id,
                        service_id,
                        quantity,
                        price
                    )
                    VALUES (?, ?, ?, ?)`,
                    [
                        invoiceId,
                        item.service_id,
                        quantity,
                        price
                    ]
                );

                const invoiceItemId = itemRes.insertId;

                // Preserve existing created items response.
                createdItems.push({
                    invoice_item_id: invoiceItemId,
                    service_id: service.id,
                    service_name: service.name,
                    quantity,
                    price
                });

                /*
                 * Scheduling is optional for backward compatibility.
                 *
                 * If sessions are supplied, one session is required
                 * for each quantity.
                 */
                if (
                    item.sessions !== undefined &&
                    item.sessions !== null
                ) {
                    if (!Array.isArray(item.sessions)) {
                        throw new Error(
                            `Sessions for ${service.name} must be an array`
                        );
                    }

                    if (item.sessions.length !== quantity) {
                        throw new Error(
                            `Service ${service.name}: provide exactly ${quantity} session schedules`
                        );
                    }

                    const durationMinutes = parseDurationMinutes(
                        service.duration
                    );

                    if (durationMinutes <= 0) {
                        throw new Error(
                            `Invalid duration configured for service ${service.id}`
                        );
                    }

                    for (
                        let index = 0;
                        index < item.sessions.length;
                        index++
                    ) {
                        const session = item.sessions[index];

                        if (!session.scheduled_start_at) {
                            throw new Error(
                                `Scheduled start time is required for ${service.name}, session ${index + 1}`
                            );
                        }

                        const scheduledStartAt = normalizeDateTime(
                            session.scheduled_start_at
                        );

                        const scheduledEndAt = addMinutesToDateTime(
                            scheduledStartAt,
                            durationMinutes
                        );

                        const [sessionRes] = await conn.query(
                            `INSERT INTO service_sessions
                (
                    invoice_item_id,
                    session_number,
                    scheduled_start_at,
                    scheduled_end_at,
                    original_duration_minutes,
                    session_status
                )
                VALUES (?, ?, ?, ?, ?, 'SCHEDULED')`,
                            [
                                invoiceItemId,
                                index + 1,
                                scheduledStartAt,
                                scheduledEndAt,
                                durationMinutes
                            ]
                        );

                        // Preserve existing created sessions response.
                        createdSessions.push({
                            session_id: sessionRes.insertId,
                            invoice_item_id: invoiceItemId,
                            service_name: service.name,
                            session_number: index + 1,
                            scheduled_start_at: scheduledStartAt,
                            scheduled_end_at: scheduledEndAt,
                            duration_minutes: durationMinutes,
                            status: "SCHEDULED"
                        });
                    }
                }
            }

            await conn.commit();

            return res.status(201).json({
                message: "Invoice created successfully",

                invoice_id: invoiceId,
                invoice_number: invoiceNumber,

                customer_id,

                payment_type: safePaymentType,

                financials: {
                    subtotal: Number(total.toFixed(2)),
                    discount_amount: discountAmount,
                    total_after_discount: Number(
                        discountedTotal.toFixed(2)
                    ),
                    vat_rate: 5,
                    vat_amount: vatAmount,
                    grand_total: grandTotal
                },

                items: createdItems,
                sessions: createdSessions
            });

        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }

    } catch (err) {
        console.error("Error creating invoice:", err);

        return res.status(400).json({
            message: "Unable to create invoice",
            error: err.message
        });
    }
});


/**
 * Append services and their scheduled sessions to an existing invoice.
 * POST /api/invoices/:id/items
 *
 * `items` uses the same shape as invoice creation, and every item must
 * include one scheduled_start_at per unit in `sessions`.
 */
router.post("/:id/items", async (req, res) => {
    const invoiceId = Number(req.params.id);
    const { items } = req.body;

    if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
        return res.status(400).json({ message: "Invalid invoice ID" });
    }

    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: "Invoice items are required" });
    }

    for (const item of items) {
        if (!item || typeof item !== "object") {
            return res.status(400).json({ message: "Invalid invoice item" });
        }

        const quantity = Number(item.quantity);
        const price = Number(item.price);

        if (
            !item.service_id ||
            !Number.isInteger(quantity) || quantity <= 0 ||
            !Number.isFinite(price) || price < 0 ||
            !Array.isArray(item.sessions) || item.sessions.length !== quantity
        ) {
            return res.status(400).json({
                message: "Each service needs a valid quantity, price, and one schedule per unit"
            });
        }
    }

    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        // Lock the invoice so concurrent additions recalculate from the latest items.
        const [invoiceRows] = await conn.query(
            `SELECT id, invoice_number, discount_type, discount_value
             FROM invoices WHERE id = ? FOR UPDATE`,
            [invoiceId]
        );

        if (!invoiceRows.length) {
            await conn.rollback();
            return res.status(404).json({ message: "Invoice not found" });
        }

        const invoice = invoiceRows[0];
        const createdItems = [];
        const createdSessions = [];

        for (const item of items) {
            const quantity = Number(item.quantity);
            const price = Number(item.price);
            const [serviceRows] = await conn.query(
                `SELECT id, name, duration
                 FROM services WHERE id = ? AND active = 1`,
                [item.service_id]
            );

            if (!serviceRows.length) {
                throw new Error(`Service ${item.service_id} not found or inactive`);
            }

            const service = serviceRows[0];
            const durationMinutes = parseDurationMinutes(service.duration);
            if (durationMinutes <= 0) {
                throw new Error(`Invalid duration configured for service ${service.id}`);
            }

            const [itemResult] = await conn.query(
                `INSERT INTO invoice_items (invoice_id, service_id, quantity, price)
                 VALUES (?, ?, ?, ?)`,
                [invoiceId, service.id, quantity, price]
            );
            const invoiceItemId = itemResult.insertId;

            createdItems.push({
                invoice_item_id: invoiceItemId,
                service_id: service.id,
                service_name: service.name,
                quantity,
                price
            });

            for (let index = 0; index < item.sessions.length; index++) {
                const scheduledStartAt = normalizeDateTime(
                    item.sessions[index]?.scheduled_start_at
                );
                const scheduledEndAt = addMinutesToDateTime(
                    scheduledStartAt,
                    durationMinutes
                );
                const [sessionResult] = await conn.query(
                    `INSERT INTO service_sessions
                     (invoice_item_id, session_number, scheduled_start_at,
                      scheduled_end_at, original_duration_minutes, session_status)
                     VALUES (?, ?, ?, ?, ?, 'SCHEDULED')`,
                    [
                        invoiceItemId,
                        index + 1,
                        scheduledStartAt,
                        scheduledEndAt,
                        durationMinutes
                    ]
                );

                createdSessions.push({
                    session_id: sessionResult.insertId,
                    invoice_item_id: invoiceItemId,
                    service_name: service.name,
                    session_number: index + 1,
                    scheduled_start_at: scheduledStartAt,
                    scheduled_end_at: scheduledEndAt,
                    duration_minutes: durationMinutes,
                    status: "SCHEDULED"
                });
            }
        }

        // Recalculate discount and VAT over the invoice's complete item list.
        const [subtotalRows] = await conn.query(
            `SELECT COALESCE(SUM(price * quantity), 0) AS subtotal
             FROM invoice_items WHERE invoice_id = ?`,
            [invoiceId]
        );
        const subtotal = Number(subtotalRows[0].subtotal);
        let discountAmount = 0;

        if (invoice.discount_type === "PERCENT") {
            discountAmount = subtotal * Number(invoice.discount_value || 0) / 100;
        } else if (invoice.discount_type === "FIXED") {
            discountAmount = Math.min(Number(invoice.discount_value || 0), subtotal);
        }

        discountAmount = Number(discountAmount.toFixed(2));
        const totalAfterDiscount = Math.max(subtotal - discountAmount, 0);
        const [extensionChargeRows] = await conn.query(
            `SELECT COALESCE(SUM(e.additional_charge), 0) AS approved_extension_amount
             FROM service_session_extensions e
             JOIN service_sessions ss ON ss.id = e.session_id
             JOIN invoice_items ii ON ii.id = ss.invoice_item_id
             WHERE ii.invoice_id = ? AND e.extension_status = 'APPROVED'`,
            [invoiceId]
        );
        const approvedExtensionAmount = Number(
            extensionChargeRows[0].approved_extension_amount || 0
        );
        const taxableSubtotal = totalAfterDiscount + approvedExtensionAmount;
        const vatAmount = Number((taxableSubtotal * VAT_RATE).toFixed(2));
        const grandTotal = Number((taxableSubtotal + vatAmount).toFixed(2));

        await conn.query(
            "UPDATE invoices SET discount_amount = ?, total_amount = ? WHERE id = ?",
            [discountAmount, grandTotal, invoiceId]
        );

        await conn.commit();

        return res.status(201).json({
            message: "Services added to invoice successfully",
            invoice_id: invoiceId,
            invoice_number: invoice.invoice_number,
            financials: {
                subtotal: Number(subtotal.toFixed(2)),
                discount_amount: discountAmount,
                total_after_discount: Number(totalAfterDiscount.toFixed(2)),
                approved_extension_amount: Number(approvedExtensionAmount.toFixed(2)),
                taxable_subtotal: Number(taxableSubtotal.toFixed(2)),
                vat_rate: 5,
                vat_amount: vatAmount,
                grand_total: grandTotal
            },
            items: createdItems,
            sessions: createdSessions
        });
    } catch (err) {
        await conn.rollback();
        console.error("Error adding services to invoice:", err);
        return res.status(400).json({
            message: "Unable to add services to invoice",
            error: err.message
        });
    } finally {
        conn.release();
    }
});


/**
 * GET invoice by ID.
 *
 * Includes:
 * - Customer details
 * - Staff name
 * - Invoice items
 * - Sessions
 * - Scheduled and actual session times
 * - Delay information
 * - Extension history
 * - Extension charges
 * - Approval information
 * - Payment status
 * - VAT breakdown
 * - Final total including approved extensions
 */
router.get("/:id", async (req, res) => {
    try {
        const invoiceId = Number(req.params.id);

        if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
            return res.status(400).json({
                message: "Invalid invoice ID"
            });
        }

        // =========================================================
        // INVOICE
        // =========================================================

        const [invoiceRows] = await pool.query(
            `
            SELECT
                i.id,
                i.invoice_number,
                i.customer_id,
                i.total_amount,
                i.payment_type,
                i.discount_type,
                i.discount_value,
                i.discount_amount,
                i.created_at,
                i.staff_name,

                c.full_name,
                c.phone,
                c.nationality

            FROM invoices i

            JOIN customers c
                ON i.customer_id = c.id

            WHERE i.id = ?
            `,
            [invoiceId]
        );

        if (invoiceRows.length === 0) {
            return res.status(404).json({
                message: "Invoice not found"
            });
        }

        const invoice = invoiceRows[0];

        invoice.payment_type =
            invoice.payment_type || "CASH";

        // =========================================================
        // INVOICE ITEMS
        // =========================================================

        const [items] = await pool.query(
            `
            SELECT
                ii.id AS invoice_item_id,
                ii.invoice_id,
                ii.service_id,
                ii.quantity,
                ii.price,

                s.name,
                s.description,
                s.duration

            FROM invoice_items ii

            JOIN services s
                ON ii.service_id = s.id

            WHERE ii.invoice_id = ?

            ORDER BY ii.id ASC
            `,
            [invoiceId]
        );

        // =========================================================
        // SESSIONS
        // =========================================================

        const [sessions] = await pool.query(
            `
            SELECT
                ss.id AS session_id,
                ss.invoice_item_id,
                ss.session_number,

                s.name AS service_name,

                ss.scheduled_start_at,
                ss.scheduled_end_at,

                ss.actual_start_at,
                ss.actual_end_at,

                ss.original_duration_minutes,

                ss.delay_minutes,
                ss.total_extension_minutes,

                ss.session_status,
                ss.notes,

                ss.created_at,
                ss.updated_at

            FROM service_sessions ss

            JOIN invoice_items ii
                ON ss.invoice_item_id = ii.id

            JOIN services s
                ON ii.service_id = s.id

            WHERE ii.invoice_id = ?

            ORDER BY ss.invoice_item_id ASC,
                     ss.session_number ASC,
                     ss.id ASC
            `,
            [invoiceId]
        );

        // =========================================================
        // EXTENSIONS
        // =========================================================

        const [extensions] = await pool.query(
            `
            SELECT
                e.id,
                e.session_id,

                e.requested_minutes,
                e.approved_minutes,

                e.previous_end_at,
                e.revised_end_at,

                e.additional_charge,

                e.extension_status,
                e.payment_status,

                e.reason,
                e.approved_by,

                e.created_at,
                e.updated_at

            FROM service_session_extensions e

            JOIN service_sessions ss
                ON e.session_id = ss.id

            JOIN invoice_items ii
                ON ss.invoice_item_id = ii.id

            WHERE ii.invoice_id = ?

            ORDER BY e.session_id ASC,
                     e.created_at ASC,
                     e.id ASC
            `,
            [invoiceId]
        );


        // =========================================================
        // DELAY RECORDS
        // =========================================================

        const [delays] = await pool.query(
            `
            SELECT
                d.id,
                d.session_id,
                d.delay_type,
                d.delay_minutes,
                d.responsible_party,
                d.reason_category,
                d.reason_details,
                d.created_at

            FROM service_session_delays d

            JOIN service_sessions ss
                ON d.session_id = ss.id

            JOIN invoice_items ii
                ON ss.invoice_item_id = ii.id

            WHERE ii.invoice_id = ?

            ORDER BY d.session_id ASC,
                     d.created_at ASC,
                     d.id ASC
            `,
            [invoiceId]
        );

        // =========================================================
        // ATTACH EXTENSIONS AND DELAYS TO THEIR SESSION
        // =========================================================

        const sessionsWithExtensions = sessions.map((session) => {
            const sessionExtensions = extensions.filter(
                (extension) =>
                    Number(extension.session_id) ===
                    Number(session.session_id)
            );

            const sessionDelays = delays.filter(
                (delay) =>
                    Number(delay.session_id) ===
                    Number(session.session_id)
            );

            return {
                ...session,
                id: session.session_id,
                extensions: sessionExtensions,
                delays: sessionDelays
            };
        });

        // =========================================================
        // ATTACH SESSIONS TO THEIR INVOICE ITEM
        // =========================================================

        const itemsWithSessions = items.map((item) => {
            const itemSessions = sessionsWithExtensions.filter(
                (session) =>
                    Number(session.invoice_item_id) ===
                    Number(item.invoice_item_id)
            );

            return {
                ...item,
                sessions: itemSessions
            };
        });
        // =========================================================
        // ORIGINAL INVOICE TOTAL
        // =========================================================

        const totalBeforeDiscount = items.reduce(
            (sum, item) =>
                sum +
                Number(item.price || 0) *
                Number(item.quantity || 0),
            0
        );

        const discountAmount = Number(
            invoice.discount_amount || 0
        );

        const totalAfterDiscount = Math.max(
            totalBeforeDiscount - discountAmount,
            0
        );

        // =========================================================
        // APPROVED EXTENSION CHARGES
        // =========================================================

        const approvedExtensionAmount = extensions
            .filter(
                (extension) =>
                    extension.extension_status === "APPROVED"
            )
            .reduce(
                (sum, extension) =>
                    sum +
                    Number(extension.additional_charge || 0),
                0
            );

        // =========================================================
        // TAXABLE TOTAL
        // =========================================================

        const taxableSubtotal =
            totalAfterDiscount +
            approvedExtensionAmount;

        // =========================================================
        // VAT
        // =========================================================

        const vatAmount = Number(
            (taxableSubtotal * VAT_RATE).toFixed(2)
        );

        // =========================================================
        // FINAL TOTAL
        // =========================================================

        const grandTotal = Number(
            (taxableSubtotal + vatAmount).toFixed(2)
        );

        // =========================================================
        // ADD CALCULATED VALUES TO INVOICE
        // =========================================================

        invoice.total_before_discount = Number(
            totalBeforeDiscount.toFixed(2)
        );

        invoice.discount_amount = Number(
            discountAmount.toFixed(2)
        );

        invoice.total_after_discount = Number(
            totalAfterDiscount.toFixed(2)
        );

        invoice.approved_extension_amount = Number(
            approvedExtensionAmount.toFixed(2)
        );

        invoice.taxable_subtotal = Number(
            taxableSubtotal.toFixed(2)
        );

        invoice.vat_rate = 5;

        invoice.vat_amount = vatAmount;

        invoice.total_amount = grandTotal;

        // =========================================================
        // RESPONSE
        // =========================================================

        return res.json({
            invoice,
            items: itemsWithSessions,
            sessions: sessionsWithExtensions,
            extensions,
            delays
        });

    } catch (err) {
        console.error("Error fetching invoice:", err);

        return res.status(500).json({
            error: err.message
        });
    }
});


/**
 * GET all invoices.
 */
router.get("/", async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT
                i.id,
                i.invoice_number,
                i.customer_id,
                i.total_amount,
                i.payment_type,
                i.created_at,
                i.staff_name,
                c.full_name

            FROM invoices i

            JOIN customers c
                ON i.customer_id = c.id

            ORDER BY i.created_at DESC`
        );

        const safeRows = rows.map(row => ({
            ...row,
            payment_type: row.payment_type || "CASH"
        }));

        return res.json(safeRows);

    } catch (err) {
        console.error("Error fetching invoices:", err);

        return res.status(500).json({
            error: err.message
        });
    }
});

module.exports = router;
