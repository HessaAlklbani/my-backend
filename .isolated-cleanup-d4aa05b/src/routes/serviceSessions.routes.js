const express = require("express");
const router = express.Router();

const pool = require("../config/db");
const pricing = require("../config/sessionPricing");

const {
    extensionBlockMinutes,
    extensionChargePerBlock
} = pricing;

function toSqlDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");

    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function getDurationBlocks(minutes) {
    return Math.ceil(minutes / extensionBlockMinutes);
}

// GET /api/service-sessions
// Today - Current Date records - as a session handler 
router.get("/", async (req, res) => {
    try {
        const { status } = req.query;

        // Get today's date in UAE time (Asia/Dubai).
        const dateParts = new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Dubai",
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
        }).formatToParts(new Date());

        const dateValues = Object.fromEntries(
            dateParts.map(({ type, value }) => [type, value])
        );

        const today = `${dateValues.year}-${dateValues.month}-${dateValues.day}`;

        let sql = `
            SELECT
                ss.*,
                ii.invoice_id,
                ii.service_id,
                s.name AS service_name,
                i.invoice_number,
                c.full_name AS customer_name,
                c.phone AS customer_phone,
                i.staff_name
            FROM service_sessions ss
            JOIN invoice_items ii ON ii.id = ss.invoice_item_id
            JOIN services s ON s.id = ii.service_id
            JOIN invoices i ON i.id = ii.invoice_id
            JOIN customers c ON c.id = i.customer_id
            WHERE DATE(ss.scheduled_start_at) = ?
        `;

        const params = [today];

        // Preserve the optional status filter.
        if (status) {
            sql += ` AND ss.session_status = ?`;
            params.push(status);
        }

        sql += ` ORDER BY ss.scheduled_start_at DESC`;

        const [rows] = await pool.execute(sql, params);

        // Attach delay history to each session.
        if (rows.length > 0) {
            const sessionIds = rows.map((session) => session.id);
            const placeholders = sessionIds.map(() => "?").join(", ");

            const [delayRows] = await pool.execute(
                `
                SELECT
                    id,
                    session_id,
                    delay_type,
                    expected_at,
                    actual_at,
                    delay_minutes,
                    responsible_party,
                    reason_category,
                    reason_details,
                    recorded_by,
                    acknowledgement_status,
                    customer_acknowledged_at,
                    customer_comments,
                    finalized_at,
                    created_at
                FROM service_session_delays
                WHERE session_id IN (${placeholders})
                ORDER BY created_at DESC
                `,
                sessionIds
            );

            const delaysBySession = new Map();

            for (const delay of delayRows) {
                if (!delaysBySession.has(delay.session_id)) {
                    delaysBySession.set(delay.session_id, []);
                }

                delaysBySession.get(delay.session_id).push(delay);
            }

            for (const session of rows) {
                session.delays = delaysBySession.get(session.id) || [];
            }
        } else {
            // Keep the response shape consistent.
            for (const session of rows) {
                session.delays = [];
            }
        }

        return res.json(rows);

    } catch (error) {
        console.error("List sessions error:", error);

        return res.status(500).json({
            message: "Failed to retrieve sessions."
        });
    }
});

// GET /api/serviceSessions/:id
router.get("/:id", async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `
            SELECT
                ss.*,
                ii.invoice_id,
                ii.service_id,
                s.name AS service_name,
                i.invoice_number,
                c.full_name AS customer_name,
                c.phone AS customer_phone,
                i.staff_name
            FROM service_sessions ss
            JOIN invoice_items ii ON ii.id = ss.invoice_item_id
            JOIN services s ON s.id = ii.service_id
            JOIN invoices i ON i.id = ii.invoice_id
            JOIN customers c ON c.id = i.customer_id
            WHERE ss.id = ?
            `,
            [req.params.id]
        );

        if (!rows.length) {
            return res.status(404).json({
                message: "Session not found."
            });
        }

        const session = rows[0];

        const [delays] = await pool.execute(
            `
            SELECT
                id,
                session_id,
                delay_type,
                expected_at,
                actual_at,
                delay_minutes,
                responsible_party,
                reason_category,
                reason_details,
                recorded_by,
                acknowledgement_status,
                customer_acknowledged_at,
                customer_comments,
                finalized_at,
                created_at
            FROM service_session_delays
            WHERE session_id = ?
            ORDER BY created_at DESC
            `,
            [session.id]
        );

        const [extensions] = await pool.execute(
            `
            SELECT *
            FROM service_session_extensions
            WHERE session_id = ?
            ORDER BY created_at DESC
            `,
            [session.id]
        );

        return res.json({
            ...session,
            delays,
            extensions
        });

    } catch (error) {
        console.error("Get session details error:", error);

        return res.status(500).json({
            message: "Failed to retrieve session details."
        });
    }
});

// PATCH /api/service-sessions/:id/start
router.patch("/:id/start", async (req, res) => {

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const [rows] = await connection.execute(
            `
            SELECT *
            FROM service_sessions
            WHERE id = ?
            FOR UPDATE
            `,
            [req.params.id]
        );

        if (!rows.length) {
            await connection.rollback();
            return res.status(404).json({
                message: "Session not found."
            });
        }

        const session = rows[0];

        if (session.session_status !== "SCHEDULED") {
            await connection.rollback();
            return res.status(409).json({
                message: `Cannot start a session with status ${session.session_status}.`
            });
        }

        // Calculate the delay using the backend time.
        const actualStart = new Date();
        const scheduledStart = new Date(session.scheduled_start_at);

        const delayMinutes = Math.max(
            0,
            Math.floor(
                (actualStart.getTime() - scheduledStart.getTime()) / 60000
            )
        );

        const actualStartSql = toSqlDate(actualStart);

        // Record the START delay separately when the activity starts late.
        if (delayMinutes > 0) {
            // Ask the frontend to collect details before recording the delay.
            // No session update or delay insert occurs in this response.
            if (
                !req.body?.reason_category ||
                typeof req.body?.recorded_by !== "string" ||
                !req.body.recorded_by.trim()
            ) {
                await connection.rollback();

                return res.status(428).json({
                    code: "START_DELAY_DETAILS_REQUIRED",
                    message:
                        "A start delay was detected. Please record the delay details before starting the activity."
                });
            }

            const validDelayReasons = {
                "Customer arrived late": "CUSTOMER",
                "Staff delay": "STAFF",
                "Equipment issue": "EQUIPMENT",
                "Weather conditions": "WEATHER",
                "Operational issue": "OPERATIONAL",
                "Other / needs explanation": "OTHER",
            };

            const reasonCategory = req.body.reason_category;

            const reasonDetails =
                typeof req.body?.reason_details === "string"
                    ? req.body.reason_details.trim()
                    : "";

            const responsibleParty = validDelayReasons[reasonCategory];

            if (!responsibleParty) {
                await connection.rollback();
                return res.status(400).json({
                    message: "Please select a valid reason for the start delay."
                });
            }

            if (
                reasonCategory === "Other / needs explanation" &&
                !reasonDetails
            ) {
                await connection.rollback();
                return res.status(400).json({
                    message:
                        "Please explain the start delay in Additional comments."
                });
            }

            if (!session.scheduled_end_at) {
                await connection.rollback();
                return res.status(409).json({
                    message: "Cannot calculate the adjusted return deadline."
                });
            }

            const recordedBy = req.body.recorded_by.trim();

            await connection.execute(
                `
                INSERT INTO service_session_delays (
                    session_id,
                    delay_type,
                    expected_at,
                    actual_at,
                    delay_minutes,
                    responsible_party,
                    reason_category,
                    reason_details,
                    recorded_by,
                    acknowledgement_status
                )
                VALUES (?, 'START', ?, ?, ?, ?, ?, ?, ?, 'PENDING')
                `,
                [
                    session.id,
                    toSqlDate(scheduledStart),
                    actualStartSql,
                    delayMinutes,
                    responsibleParty,
                    reasonCategory,
                    reasonDetails || null,
                    recordedBy
                ]
            );
        }

        // Start the session only after any required delay details are valid.
        await connection.execute(
            `
            UPDATE service_sessions
            SET
                actual_start_at = ?,
                delay_minutes = ?,
                session_status = 'IN_PROGRESS'
            WHERE id = ?
            `,
            [
                actualStartSql,
                delayMinutes,
                session.id
            ]
        );

        await connection.commit();

        return res.json({
            message: "Activity started successfully.",
            session_id: session.id,
            actual_start_at: actualStartSql,
            delay_minutes: delayMinutes,
            start_delay_record_created: delayMinutes > 0,
            session_status: "IN_PROGRESS"
        });

    } catch (error) {
        await connection.rollback();

        console.error("Start session error:", error);

        return res.status(500).json({
            message: "Failed to start session."
        });
    } finally {
        connection.release();
    }
});


// PATCH /api/serviceSessions/delays/:delayId/acknowledgement
router.patch(
    "/delays/:delayId/acknowledgement",
    async (req, res) => {
        const { delayId } = req.params;
        const { acknowledgement_status, customer_comments } = req.body;

        if (!["ACKNOWLEDGED", "DISPUTED"].includes(acknowledgement_status)) {
            return res.status(400).json({
                message: "Acknowledgement status must be ACKNOWLEDGED or DISPUTED.",
            });
        }

        const comments =
            typeof customer_comments === "string"
                ? customer_comments.trim()
                : "";

        if (acknowledgement_status === "DISPUTED" && !comments) {
            return res.status(400).json({
                message: "Please provide comments when disputing a delay.",
            });
        }

        try {
            const [result] = await pool.execute(
                `UPDATE service_session_delays
                SET acknowledgement_status = ?,
                    customer_comments = ?,
                    customer_acknowledged_at =
                        CASE WHEN ? = 'ACKNOWLEDGED' THEN NOW() ELSE NULL END,
                    finalized_at =
                        CASE WHEN ? = 'ACKNOWLEDGED' THEN NOW() ELSE NULL END,
                    updated_at = NOW()
                WHERE id = ?
                    AND acknowledgement_status = 'PENDING'`,
                [
                    acknowledgement_status,
                    comments || null,
                    acknowledgement_status,
                    acknowledgement_status,
                    delayId,
                ]
            );

            if (result.affectedRows === 0) {
                return res.status(409).json({
                    message:
                        "This delay was already acknowledged, disputed, or no longer exists.",
                });
            }

            const [rows] = await pool.execute(
                `SELECT *
                    FROM service_session_delays
                    WHERE id = ?`,
                [delayId]
            );

            return res.json({
                message: "Delay acknowledgement saved successfully.",
                delay: rows[0],
            });
        } catch (error) {
            console.error("Delay acknowledgement error:", error);
            return res.status(500).json({
                message: "Failed to save delay acknowledgement.",
            });
        }
    }
);


// POST /api/serviceSessions/:id/extensions
router.post("/:id/extensions", async (req, res) => {
    const connection = await pool.getConnection();

    try {
        const {
            requested_minutes,
            additional_charge,
            reason,
            approved_by
        } = req.body;
        if (
            additional_charge === undefined ||
            additional_charge === null ||
            Number.isNaN(Number(additional_charge)) ||
            Number(additional_charge) < 0
        ) {
            return res.status(400).json({
                message: "additional_charge must be a valid non-negative amount."
            });
        }
        if (
            !Number.isInteger(Number(requested_minutes)) ||
            Number(requested_minutes) <= 0
        ) {
            return res.status(400).json({
                message: "requested_minutes must be a positive integer."
            });
        }

        if (
            !Number.isInteger(extensionBlockMinutes) ||
            extensionBlockMinutes <= 0 ||
            Number(extensionChargePerBlock) < 0
        ) {
            return res.status(500).json({
                message: "Extension pricing is not configured correctly."
            });
        }

        await connection.beginTransaction();

        const [rows] = await connection.execute(
            `SELECT * FROM service_sessions WHERE id = ? FOR UPDATE`,
            [req.params.id]
        );

        if (!rows.length) {
            await connection.rollback();
            return res.status(404).json({ message: "Session not found." });
        }

        const session = rows[0];

        if (session.session_status !== "IN_PROGRESS" && session.session_status !== "COMPLETED") {
            await connection.rollback();
            return res.status(409).json({
                message: "Extensions can only be requested for active or completed sessions."
            });
        }

        const [pending] = await connection.execute(
            `
      SELECT id
      FROM service_session_extensions
      WHERE session_id = ?
        AND extension_status = 'REQUESTED'
      LIMIT 1
      `,
            [session.id]
        );

        if (pending.length) {
            await connection.rollback();
            return res.status(409).json({
                message: "There is already a pending extension request."
            });
        }

        const [result] = await connection.execute(
            `
            INSERT INTO service_session_extensions (
                session_id,
                requested_minutes,
                previous_end_at,
                additional_charge,
                reason,
                extension_status,
                payment_status,
                approved_by
            )
            VALUES (?, ?, ?, ?, ?, 'REQUESTED', 'UNPAID', ?)
    `,
            [
                session.id,
                Number(requested_minutes),
                session.scheduled_end_at,
                Number(additional_charge),
                reason || null,
                approved_by || null
            ]
        );

        await connection.commit();

        res.status(201).json({
            message: "Extension request submitted.",
            extension_id: result.insertId,
            status: "REQUESTED"
        });
    } catch (error) {
        await connection.rollback();
        console.error("Extension request error:", error);
        res.status(500).json({
            message: "Failed to create extension request."
        });
    } finally {
        connection.release();
    }
});

// PATCH /api/service-sessions/extensions/:extensionId/approve
router.patch("/extensions/:extensionId/approve", async (req, res) => {
    const connection = await pool.getConnection();

    try {
        const {
            approved_minutes,
            additional_charge,
            approved_by
        } = req.body;

        if (
            !Number.isInteger(Number(approved_minutes)) ||
            Number(approved_minutes) <= 0
        ) {
            return res.status(400).json({
                message: "approved_minutes must be a positive integer."
            });
        }

        if (
            additional_charge === undefined ||
            additional_charge === null ||
            Number.isNaN(Number(additional_charge)) ||
            Number(additional_charge) < 0
        ) {
            return res.status(400).json({
                message: "additional_charge must be a valid non-negative amount."
            });
        }

        await connection.beginTransaction();

        const [extensions] = await connection.execute(
            `
      SELECT e.*, ss.session_status AS session_status,
             ss.scheduled_end_at
      FROM service_session_extensions e
      JOIN service_sessions ss ON ss.id = e.session_id
      WHERE e.id = ?
      FOR UPDATE
      `,
            [req.params.extensionId]
        );

        if (!extensions.length) {
            await connection.rollback();
            return res.status(404).json({
                message: "Extension request not found."
            });
        }

        const extension = extensions[0];

        if (extension.extension_status !== "REQUESTED") {
            await connection.rollback();
            return res.status(409).json({
                message: "This extension has already been processed."
            });
        }

        if (extension.session_status !== "IN_PROGRESS" && extension.session_status !== "COMPLETED") {
            await connection.rollback();
            return res.status(409).json({
                message: "The session is not active or completed."
            });
        }

        const approved = Number(approved_minutes);

        if (approved > extension.requested_minutes) {
            await connection.rollback();
            return res.status(400).json({
                message: "Approved time cannot exceed requested time."
            });
        }

        const currentEnd = new Date(extension.scheduled_end_at);

        const revisedEnd = new Date(
            currentEnd.getTime() + approved * 60000
        );



        await connection.execute(
            `
            UPDATE service_session_extensions
            SET
                approved_minutes = ?,
                revised_end_at = ?,
                additional_charge = ?,
                extension_status = 'APPROVED',
                payment_status = 'UNPAID',
                approved_by = ?
            WHERE id = ?
            `,
            [
                approved,
                toSqlDate(revisedEnd),
                Number(additional_charge),
                approved_by || null,
                extension.id
            ]
        );

        if (extension.session_status === "COMPLETED") {
            // Retrospective extensions must not rewrite the completed session's schedule.
            await connection.execute(
                `
                UPDATE service_sessions
                SET total_extension_minutes = total_extension_minutes + ?
                WHERE id = ?
                `,
                [approved, extension.session_id]
            );
        } else {
            await connection.execute(
                `
                UPDATE service_sessions
                SET scheduled_end_at = ?,
                    total_extension_minutes = total_extension_minutes + ?
                WHERE id = ?
                `,
                [toSqlDate(revisedEnd), approved, extension.session_id]
            );
        }

        await connection.commit();

        res.json({
            message: "Extension approved.",
            extension_id: extension.id,
            approved_minutes: approved,
            revised_end_at: toSqlDate(revisedEnd),
            additional_charge: Number(additional_charge),
            payment_status: "UNPAID"
        });
    } catch (error) {
        await connection.rollback();
        console.error("Approve extension error:", error);
        res.status(500).json({
            message: "Failed to approve extension."
        });
    } finally {
        connection.release();
    }
});

// PATCH /api/service-sessions/extensions/:extensionId/reject
router.patch("/extensions/:extensionId/reject", async (req, res) => {
    try {
        const { rejection_reason, approved_by } = req.body;

        const [result] = await pool.execute(
            `
      UPDATE service_session_extensions
      SET
        extension_status = 'REJECTED',
        reason = ?,
        approved_by = ?
      WHERE id = ?
        AND extension_status = 'REQUESTED'
      `,
            [
                rejection_reason || null,
                approved_by || null,
                req.params.extensionId
            ]
        );

        if (!result.affectedRows) {
            return res.status(404).json({
                message: "Pending extension request not found."
            });
        }

        res.json({
            message: "Extension rejected."
        });
    } catch (error) {
        console.error("Reject extension error:", error);
        res.status(500).json({
            message: "Failed to reject extension."
        });
    }
});

// PATCH /api/service-sessions/:id/complete
router.patch("/:id/complete", async (req, res) => {
    const connection = await pool.getConnection();
    let transactionStarted = false;

    try {
        const { notes } = req.body || {};

        await connection.beginTransaction();
        transactionStarted = true;

        const [rows] = await connection.execute(
            `
            SELECT ss.*, i.staff_name
            FROM service_sessions ss
            JOIN invoice_items ii ON ii.id = ss.invoice_item_id
            JOIN invoices i ON i.id = ii.invoice_id
            WHERE ss.id = ?
            FOR UPDATE
            `,
            [req.params.id]
        );

        if (!rows.length) {
            await connection.rollback();
            transactionStarted = false;

            return res.status(404).json({
                message: "Session not found.",
            });
        }

        const session = rows[0];

        if (session.session_status !== "IN_PROGRESS") {
            await connection.rollback();
            transactionStarted = false;

            return res.status(409).json({
                message: "Only active sessions can be completed.",
            });
        }

        // Preserve the existing extension workflow.
        const [pending] = await connection.execute(
            `
            SELECT id
            FROM service_session_extensions
            WHERE session_id = ?
              AND extension_status = 'REQUESTED'
            LIMIT 1
            `,
            [session.id]
        );

        if (pending.length) {
            await connection.rollback();
            transactionStarted = false;

            return res.status(409).json({
                message:
                    "Resolve the pending extension before completing.",
            });
        }

        const [recordedReturnDelays] = await connection.execute(
            `
            SELECT actual_at, delay_minutes, acknowledgement_status
            FROM service_session_delays
            WHERE session_id = ?
              AND delay_type = 'RETURN'
            ORDER BY id DESC
            LIMIT 1
            FOR UPDATE
            `,
            [session.id]
        );

        const scheduledEnd = new Date(session.scheduled_end_at);
        const actualEnd = recordedReturnDelays.length
            ? new Date(recordedReturnDelays[0].actual_at)
            : session.actual_end_at
                ? new Date(session.actual_end_at)
                : new Date();
        const actualEndSql = toSqlDate(actualEnd);

        const returnDelayMinutes = recordedReturnDelays.length
            ? Number(recordedReturnDelays[0].delay_minutes)
            : Math.max(
                0,
                Math.floor(
                    (actualEnd.getTime() - scheduledEnd.getTime()) / 60000
                )
            );

        // The first click only captures the return time. Commit it before
        // asking staff for delay details or asking the customer to respond, so
        // neither step can keep the elapsed timer running.
        if (!session.actual_end_at) {
            await connection.execute(
                `UPDATE service_sessions SET actual_end_at = ? WHERE id = ?`,
                [actualEndSql, session.id]
            );

            if (returnDelayMinutes > 0) {
                await connection.commit();
                transactionStarted = false;

                return res.status(409).json({
                    code: "RETURN_DELAY_DETAILS_REQUIRED",
                    message: "Return time recorded. This activity ended late. Please record the delay reason and staff name. The customer can respond later.",
                    session_id: session.id,
                    actual_end_at: actualEndSql,
                    return_delay_minutes: returnDelayMinutes,
                    session_status: "IN_PROGRESS",
                });
            }
        }

        // Only request delay details if the system detects a return delay.
        if (returnDelayMinutes > 0 && !recordedReturnDelays.length) {
            const recordedBy =
                typeof req.body?.recorded_by === "string"
                    ? req.body.recorded_by.trim()
                    : "";

            const validDelayReasons = {
                "Customer arrived late": "CUSTOMER",
                "Staff delay": "STAFF",
                "Equipment issue": "EQUIPMENT",
                "Weather conditions": "WEATHER",
                "Operational issue": "OPERATIONAL",
                "Other / needs explanation": "OTHER",
            };

            const reasonCategory = req.body?.reason_category;

            const reasonDetails =
                typeof req.body?.reason_details === "string"
                    ? req.body.reason_details.trim()
                    : "";

            // The frontend uses this code to decide whether to open the form.
            if (!recordedBy || !validDelayReasons[reasonCategory]) {
                await connection.commit();
                transactionStarted = false;

                return res.status(409).json({
                    code: "RETURN_DELAY_DETAILS_REQUIRED",
                    message: "Return time is saved. Please record the delay reason and staff name.",
                    session_id: session.id,
                    actual_end_at: actualEndSql,
                    return_delay_minutes: returnDelayMinutes,
                    session_status: "IN_PROGRESS",
                });
            }

            if (
                reasonCategory === "Other / needs explanation" &&
                !reasonDetails
            ) {
                await connection.commit();
                transactionStarted = false;

                return res.status(400).json({
                    code: "RETURN_DELAY_DETAILS_REQUIRED",
                    message:
                        "Please explain the delay in Additional comments.",
                });
            }

            await connection.execute(
                `
                INSERT INTO service_session_delays (
                    session_id,
                    delay_type,
                    expected_at,
                    actual_at,
                    delay_minutes,
                    responsible_party,
                    reason_category,
                    reason_details,
                    recorded_by,
                    acknowledgement_status
                )
                VALUES (?, 'RETURN', ?, ?, ?, ?, ?, ?, ?, 'PENDING')
                `,
                [
                    session.id,
                    toSqlDate(scheduledEnd),
                    actualEndSql,
                    returnDelayMinutes,
                    validDelayReasons[reasonCategory],
                    reasonCategory,
                    reasonDetails || null,
                    recordedBy,
                ]
            );

            await connection.execute(
                `
                UPDATE service_sessions
                SET
                    actual_end_at = ?,
                    session_status = 'COMPLETED',
                    notes = ?
                WHERE id = ?
                `,
                [actualEndSql, notes || null, session.id]
            );

            await connection.commit();
            transactionStarted = false;

            return res.json({
                message: "Return time recorded and activity completed. The customer can acknowledge or dispute the delay later.",
                session_id: session.id,
                actual_end_at: actualEndSql,
                return_delay_minutes: returnDelayMinutes,
                return_delay_record_created: true,
                acknowledgement_status: "PENDING",
                status: "COMPLETED",
                session_status: "COMPLETED",
            });
        }

        // Finalize with the return time captured on the first completion click. Customer acknowledgement is recorded separately.
        await connection.execute(
            `
            UPDATE service_sessions
            SET
                actual_end_at = ?,
                session_status = 'COMPLETED',
                notes = ?
            WHERE id = ?
            `,
            [
                actualEndSql,
                notes || null,
                session.id,
            ]
        );

        await connection.commit();
        transactionStarted = false;

        return res.json({
            message: "Activity completed using the recorded return time. The customer can acknowledge or dispute delays later.",
            session_id: session.id,
            actual_end_at: actualEndSql,
            return_delay_minutes: returnDelayMinutes,
            return_delay_record_created:
                !recordedReturnDelays.length && returnDelayMinutes > 0,
            acknowledgement_status:
                recordedReturnDelays.length ? recordedReturnDelays[0].acknowledgement_status : null,
            status: "COMPLETED",
        });
    } catch (error) {
        if (transactionStarted) {
            await connection.rollback();
        }

        console.error("Complete session error:", error);

        return res.status(500).json({
            message: "Failed to complete session.",
        });
    } finally {
        connection.release();
    }
});



// PATCH /api/service-sessions/extensions/:extensionId/payment
router.patch(
    "/extensions/:extensionId/payment",
    async (req, res) => {
        try {
            const { payment_status } = req.body;

            if (!["PAID", "REJECT"].includes(payment_status)) {
                return res.status(400).json({
                    message: "payment_status must be PAID or REJECT."
                });
            }

            const [result] = await pool.execute(
                `
            UPDATE service_session_extensions
            SET
                payment_status = ?
            WHERE id = ?
            AND extension_status = 'APPROVED'
            AND payment_status = 'UNPAID'
        `,
                [
                    payment_status,
                    req.params.extensionId
                ]
            );

            if (!result.affectedRows) {
                return res.status(404).json({
                    message: "Approved unpaid extension not found."
                });
            }

            res.json({
                message: "Extension payment status updated.",
                payment_status
            });
        } catch (error) {
            console.error("Extension payment error:", error);
            res.status(500).json({
                message: "Failed to update extension payment."
            });
        }
    }
);

module.exports = router;
