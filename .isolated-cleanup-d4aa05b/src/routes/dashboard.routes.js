const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const dashboardAuth = require("../middleware/dashboardAuth");

const money = (value) => Number(Number(value || 0).toFixed(2));

/* ================= FINANCE, VAT & PROFIT REPORT ================= */
router.get("/finance", dashboardAuth, async (req, res) => {
  const from = String(req.query.from || "");
  const to = String(req.query.to || "");
  const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

  if (!validDate(from) || !validDate(to) || from > to) {
    return res.status(400).json({ message: "Provide a valid from and to date (YYYY-MM-DD)" });
  }

  try {
    const [invoices] = await pool.query(
      `SELECT i.id, i.invoice_number, i.created_at, i.total_amount,
              i.discount_amount, i.payment_type, i.staff_name, c.full_name,
              COALESCE((
                SELECT SUM(ii.quantity * ii.price)
                FROM invoice_items ii WHERE ii.invoice_id = i.id
              ), 0) AS items_subtotal,
              COALESCE((
                SELECT GROUP_CONCAT(CONCAT(s.name, ' × ', ii.quantity) ORDER BY ii.id SEPARATOR '; ')
                FROM invoice_items ii
                JOIN services s ON s.id = ii.service_id
                WHERE ii.invoice_id = i.id
              ), '') AS item_summary,
              COALESCE((
                SELECT SUM(e.additional_charge)
                FROM service_session_extensions e
                JOIN service_sessions ss ON ss.id = e.session_id
                JOIN invoice_items ii ON ii.id = ss.invoice_item_id
                WHERE ii.invoice_id = i.id AND e.extension_status = 'APPROVED'
              ), 0) AS approved_extension_amount,
              COALESCE((
                SELECT SUM(CASE WHEN e.payment_status = 'PAID' THEN e.additional_charge ELSE 0 END)
                FROM service_session_extensions e
                JOIN service_sessions ss ON ss.id = e.session_id
                JOIN invoice_items ii ON ii.id = ss.invoice_item_id
                WHERE ii.invoice_id = i.id AND e.extension_status = 'APPROVED'
              ), 0) AS paid_extension_amount
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id
       WHERE i.created_at >= ? AND i.created_at < DATE_ADD(?, INTERVAL 1 DAY)
       ORDER BY i.created_at DESC`,
      [from, to]
    );

    const [expenses] = await pool.query(
      `SELECT id, title, amount, description, expense_date, created_by, bill_image,
              supplier_name, supplier_trn, supplier_invoice_number,
              expense_net_amount, vat_rate, vat_amount,
              recoverable_vat_amount, vat_treatment, amount_includes_vat
       FROM expenses
       WHERE expense_date >= ? AND expense_date < DATE_ADD(?, INTERVAL 1 DAY)
       ORDER BY expense_date DESC, id DESC`,
      [from, to]
    );

    const [[paidDamageCollections]] = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM damage_bills
       WHERE payment_status = 'PAID'
         AND paid_at >= ? AND paid_at < DATE_ADD(?, INTERVAL 1 DAY)`,
      [from, to]
    );
    const invoiceLedger = invoices.map((row) => {
      const subtotal = Number(row.items_subtotal || 0);
      const discount = Number(row.discount_amount || 0);
      const netSales = Math.max(subtotal - discount, 0);
      const extensionNet = Number(row.approved_extension_amount || 0);
      return {
        ...row,
        items_subtotal: money(subtotal),
        discount_amount: money(discount),
        net_sales: money(netSales),
        output_vat: money(netSales * 0.05 + extensionNet * 0.05),
        gross_sales: money(netSales * 1.05 + extensionNet * 1.05),
        approved_extension_amount: money(extensionNet),
        paid_extension_amount: money(row.paid_extension_amount)
      };
    });

    const expenseLedger = expenses.map((row) => {
      const gross = Number(row.amount || 0);
      const vatRecorded = row.vat_amount == null ? null : Number(row.vat_amount);
      const recoverableRecorded = row.recoverable_vat_amount == null
        ? 0
        : Number(row.recoverable_vat_amount);
      const hasSupportingDocument = Boolean(row.bill_image && row.supplier_invoice_number && row.supplier_trn && row.supplier_name);
      const amountIncludesVat = row.amount_includes_vat == null ? null : Number(row.amount_includes_vat) === 1;
      const hasVatEvidence = hasSupportingDocument && amountIncludesVat === true;
      const eligibleInputVat = row.vat_treatment === "STANDARD" && vatRecorded !== null && hasVatEvidence
        ? recoverableRecorded
        : 0;
            const isClassified = Boolean(row.vat_treatment && row.vat_treatment !== "UNKNOWN" && hasSupportingDocument && (
        row.vat_treatment === "STANDARD"
          ? vatRecorded !== null && amountIncludesVat === true
          : amountIncludesVat === false && (vatRecorded === null || vatRecorded === 0)
      ));
      return {
        ...row,
        amount: money(gross),
        vat_amount: vatRecorded == null ? null : money(vatRecorded),
        recoverable_vat_amount: money(recoverableRecorded),
        eligible_input_vat: money(eligibleInputVat),
        operating_expense: money(Math.max(gross - eligibleInputVat, 0)),
        vat_record_status: isClassified && vatRecorded != null ? "RECORDED" : "NEEDS_REVIEW"
      };
    });

    const totals = invoiceLedger.reduce((sum, row) => {
      sum.invoice_net_sales += row.net_sales;
      sum.invoice_output_vat += row.output_vat;
      sum.approved_extensions_net += row.approved_extension_amount;
      sum.paid_extensions_net += row.paid_extension_amount;
      sum.gross_sales += row.gross_sales;
      return sum;
    }, {
      invoice_net_sales: 0,
      invoice_output_vat: 0,
      approved_extensions_net: 0,
      paid_extensions_net: 0,
      gross_sales: 0
    });

    const expenseTotals = expenseLedger.reduce((sum, row) => {
      sum.gross_expenses += row.amount;
      sum.operating_expenses += row.operating_expense;
      sum.recoverable_input_vat += row.eligible_input_vat;
      sum.input_vat_needs_review += Math.max(row.recoverable_vat_amount - row.eligible_input_vat, 0);
      if (row.vat_record_status === "NEEDS_REVIEW") {
        sum.unclassified_expenses += row.amount;
        sum.unclassified_expense_count += 1;
      }
      return sum;
    }, {
      gross_expenses: 0,
      operating_expenses: 0,
      recoverable_input_vat: 0,
      input_vat_needs_review: 0,
      unclassified_expenses: 0,
      unclassified_expense_count: 0
    });

    Object.keys(totals).forEach((key) => { totals[key] = money(totals[key]); });
    Object.keys(expenseTotals).forEach((key) => {
      if (key !== "unclassified_expense_count") expenseTotals[key] = money(expenseTotals[key]);
    });

    const totalRevenueExVat = money(totals.invoice_net_sales + totals.paid_extensions_net);
    const netVatPosition = money(totals.invoice_output_vat - expenseTotals.recoverable_input_vat);

    return res.json({
      period: { from, to },
      currency: "AED",
      assumptions: {
        sales_vat_rate: 5,
        sales_vat_basis: "All legacy invoice service prices are treated as VAT-exclusive and standard-rated at 5%, matching the current invoice creation calculation; verify tax point and supply classification before filing.",
        extension_period_basis: "Approved extensions are grouped under the related invoice date because extension tax-point dates are not stored.",
        legacy_expenses: "Expenses without recorded VAT details are included at their full amount in operating expenses and excluded from recoverable input VAT.",
        damage_profit_basis: "Collected damage bills are included in operating profit at the recorded amount. Damage bill records do not store VAT treatment, so these amounts are not included in the VAT estimate.",
        invoice_document_gaps: "Invoice VAT is recalculated from current item rows instead of stored as an immutable tax snapshot. Records also lack supplier TRN/address, customer address/TRN, a separate supply date, per-line VAT category, and credit-note/refund history; this report is not a substitute for a compliant tax invoice or VAT return."
      },
      summary: {
        invoice_net_sales: totals.invoice_net_sales,
        approved_extensions_net: totals.approved_extensions_net,
        paid_extensions_net: totals.paid_extensions_net,
        gross_sales_including_vat: totals.gross_sales,
        output_vat: totals.invoice_output_vat,
        gross_expenses: expenseTotals.gross_expenses,
        operating_expenses: expenseTotals.operating_expenses,
        recoverable_input_vat: expenseTotals.recoverable_input_vat,
        input_vat_needs_review: expenseTotals.input_vat_needs_review,
        estimated_vat_payable: money(Math.max(netVatPosition, 0)),
        estimated_vat_credit: money(Math.max(-netVatPosition, 0)),
        operating_profit_estimate: money(totalRevenueExVat + Number(paidDamageCollections.total || 0) - expenseTotals.operating_expenses),
        paid_damage_collections: money(paidDamageCollections.total),
        unclassified_expenses: expenseTotals.unclassified_expenses,
        unclassified_expense_count: expenseTotals.unclassified_expense_count
      },
      invoices: invoiceLedger,
      expenses: expenseLedger
    });
  } catch (err) {
    console.error("Finance report error:", err);
    return res.status(500).json({ message: "Unable to load finance report" });
  }
});

/* 🔐 LOGIN CHECK */
router.post("/login", (req, res) => {
  const password = req.headers["x-dashboard-password"];
  if (!password) return res.status(401).json({ message: "Password required" });
  if (password !== process.env.DASHBOARD_PASSWORD)
    return res.status(403).json({ message: "Invalid password" });
  res.json({ success: true });
});

/* 📊 FULL DASHBOARD STATUS */
router.get("/status", dashboardAuth, async (req, res) => {
  try {
    /* ===== TODAY ===== */
    const [[todayCustomers]] = await pool.query(
      `SELECT COUNT(*) AS count FROM customers WHERE DATE(created_at)=CURDATE()`
    );

    const [[todayInvoices]] = await pool.query(
      `SELECT COUNT(*) AS count, IFNULL(SUM(total_amount),0) AS total
       FROM invoices WHERE DATE(created_at)=CURDATE()`
    );

    const [[allInvoicesTotal]] = await pool.query(
      `SELECT COALESCE(SUM(GREATEST(COALESCE(item_totals.subtotal, 0) - COALESCE(i.discount_amount, 0), 0)), 0) AS total
       FROM invoices i
       LEFT JOIN (
         SELECT invoice_id, SUM(quantity * price) AS subtotal
         FROM invoice_items
         GROUP BY invoice_id
       ) item_totals ON item_totals.invoice_id = i.id`
    );

    const [[paidExtensionsTotal]] = await pool.query(
      `SELECT COALESCE(SUM(additional_charge), 0) AS total
       FROM service_session_extensions
       WHERE extension_status = 'APPROVED' AND payment_status = 'PAID'`
    );

    const [[topServiceToday]] = await pool.query(
      `SELECT s.name, SUM(ii.quantity) AS total_sold
       FROM invoice_items ii
       JOIN services s ON s.id = ii.service_id
       JOIN invoices i ON i.id = ii.invoice_id
       WHERE DATE(i.created_at) = CURDATE()
       GROUP BY s.name
       ORDER BY total_sold DESC
       LIMIT 1`
    );

    /* ===== CUSTOMERS ===== */
    const [[newCustomersWeek]] = await pool.query(
      `SELECT COUNT(*) AS count
       FROM customers
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)`
    );

    const [[inactiveCustomers]] = await pool.query(
      `SELECT COUNT(*) AS count
       FROM customers c
       WHERE NOT EXISTS (
         SELECT 1
         FROM invoices i
         WHERE i.customer_id = c.id
           AND i.created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
       )`
    );

    const [frequentCustomers] = await pool.query(
      `SELECT c.id AS customer_id, c.phone, c.full_name,
              COUNT(i.id) AS visits
       FROM customers c
       JOIN invoices i ON i.customer_id = c.id
       WHERE i.created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
       GROUP BY c.id, c.phone, c.full_name
       HAVING visits >= 2
       ORDER BY visits DESC`
    );

    /* ===== SESSION OPERATIONS ===== */
    const [[todaySessions]] = await pool.query(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(session_status = 'SCHEDULED'), 0) AS scheduled,
         COALESCE(SUM(session_status = 'IN_PROGRESS'), 0) AS in_progress,
         COALESCE(SUM(session_status = 'COMPLETED'), 0) AS completed,
         COALESCE(SUM(session_status = 'IN_PROGRESS' AND scheduled_end_at < NOW()), 0) AS overdue
       FROM service_sessions
       WHERE DATE(scheduled_start_at) = CURDATE()`
    );

    const [[activeSessions]] = await pool.query(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(scheduled_end_at < NOW()), 0) AS overdue
       FROM service_sessions
       WHERE session_status = 'IN_PROGRESS'`
    );

    const [activeSessionList] = await pool.query(
      `SELECT
         ss.id AS session_id,
         ss.session_status,
         ss.scheduled_start_at,
         ss.scheduled_end_at,
         ss.actual_start_at,
         ss.actual_end_at,
         ii.invoice_id,
         i.invoice_number,
         c.full_name AS customer_name,
         s.name AS service_name,
         i.staff_name,
         ss.total_extension_minutes,
         (SELECT COUNT(*)
          FROM service_session_delays d
          WHERE d.session_id = ss.id
            AND COALESCE(d.acknowledgement_status, 'PENDING') = 'PENDING'
         ) AS pending_delay_count,
         (ss.scheduled_end_at < NOW()) AS is_overdue
       FROM service_sessions ss
       JOIN invoice_items ii ON ii.id = ss.invoice_item_id
       JOIN invoices i ON i.id = ii.invoice_id
       JOIN customers c ON c.id = i.customer_id
       JOIN services s ON s.id = ii.service_id
       WHERE ss.session_status = 'IN_PROGRESS'
       ORDER BY ss.scheduled_end_at ASC
       LIMIT 100`
    );

    const [[pendingDelayAcknowledgements]] = await pool.query(
      `SELECT COUNT(*) AS count
       FROM service_session_delays
       WHERE COALESCE(acknowledgement_status, 'PENDING') = 'PENDING'`
    );

    const [delayTrends] = await pool.query(
      `SELECT
         delay_type,
         COUNT(*) AS delay_count,
         COALESCE(SUM(delay_minutes), 0) AS total_delay_minutes,
         COALESCE(AVG(delay_minutes), 0) AS average_delay_minutes,
         COALESCE(SUM(acknowledgement_status = 'PENDING'), 0) AS pending_acknowledgements,
         COALESCE(SUM(acknowledgement_status = 'DISPUTED'), 0) AS disputed_count
       FROM service_session_delays
       WHERE actual_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
       GROUP BY delay_type
       ORDER BY delay_type`
    );

    const [delaysByReason] = await pool.query(
      `SELECT
         delay_type,
         COALESCE(reason_category, 'Unspecified') AS reason_category,
         COUNT(*) AS delay_count,
         COALESCE(SUM(delay_minutes), 0) AS total_delay_minutes
       FROM service_session_delays
       WHERE actual_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
       GROUP BY delay_type, reason_category
       ORDER BY delay_count DESC, total_delay_minutes DESC`
    );

    const [[sessionTiming]] = await pool.query(
      `SELECT
         COUNT(*) AS completed_sessions,
         COALESCE(SUM(
           CASE
             WHEN COALESCE(ss.delay_minutes, 0) = 0
              AND NOT EXISTS (
                SELECT 1
                FROM service_session_delays d
                WHERE d.session_id = ss.id
                  AND d.delay_type = 'RETURN'
                  AND d.delay_minutes > 0
              )
             THEN 1 ELSE 0
           END
         ), 0) AS on_time_sessions
       FROM service_sessions ss
       WHERE ss.session_status = 'COMPLETED'
         AND ss.actual_end_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`
    );

    const onTimeRate = sessionTiming.completed_sessions
      ? Number((
          sessionTiming.on_time_sessions /
          sessionTiming.completed_sessions * 100
        ).toFixed(1))
      : 0;

    const [[extensionTracking]] = await pool.query(
      `SELECT
         COALESCE(SUM(extension_status = 'REQUESTED'), 0) AS pending_requests,
         COALESCE(SUM(extension_status = 'APPROVED'
             AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)), 0) AS approved_last_7_days,
         COALESCE(SUM(CASE
             WHEN extension_status = 'APPROVED'
              AND payment_status = 'UNPAID'
             THEN additional_charge ELSE 0 END), 0) AS approved_unpaid_amount
       FROM service_session_extensions`
    );

    /* ===== REVIEWS ===== */
    const [[latestReview]] = await pool.query(
      `SELECT full_name, message, created_at
       FROM reviews
       ORDER BY created_at DESC
       LIMIT 1`
    );

    /* ===== SALES ===== */
    const [salesLast7Days] = await pool.query(
      `SELECT DATE(created_at) AS date, IFNULL(SUM(total_amount),0) AS total
       FROM invoices
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
       GROUP BY DATE(created_at)
       ORDER BY DATE(created_at)`
    );

    const [topServicesMonth] = await pool.query(
      `SELECT s.name, SUM(ii.quantity) AS total_sold
       FROM invoice_items ii
       JOIN services s ON s.id = ii.service_id
       JOIN invoices i ON i.id = ii.invoice_id
       WHERE i.created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
       GROUP BY s.name
       ORDER BY total_sold DESC
       LIMIT 5`
    );

    const [monthlySales] = await pool.query(
      `SELECT MONTH(created_at) AS month, IFNULL(SUM(total_amount),0) AS total
       FROM invoices
       WHERE YEAR(created_at) = YEAR(CURDATE())
       GROUP BY MONTH(created_at)
       ORDER BY MONTH(created_at)`
    );

    const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const monthlySalesFormatted = monthlySales.map(m => ({
      month: monthNames[m.month - 1],
      total: m.total
    }));

    const [yearlySales] = await pool.query(
      `SELECT YEAR(created_at) AS year, IFNULL(SUM(total_amount),0) AS total
       FROM invoices
       GROUP BY YEAR(created_at)
       ORDER BY YEAR(created_at)`
    );

    /* ===== EXPENSES ===== */
    const [[expensesTotal]] = await pool.query(
      `SELECT COUNT(*) AS count, IFNULL(SUM(amount),0) AS total FROM expenses`
    );

    const [[operatingExpensesTotal]] = await pool.query(
      `SELECT COALESCE(SUM(GREATEST(amount - CASE
         WHEN vat_treatment = 'STANDARD'
          AND vat_amount IS NOT NULL
          AND bill_image IS NOT NULL AND bill_image <> ''
          AND supplier_invoice_number IS NOT NULL AND supplier_invoice_number <> ''
          AND supplier_trn IS NOT NULL AND supplier_trn <> ''
          AND supplier_name IS NOT NULL AND supplier_name <> ''
         THEN COALESCE(recoverable_vat_amount, 0)
         ELSE 0
       END, 0)), 0) AS total
       FROM expenses`
    );

    const [expensesByTitle] = await pool.query(
      `SELECT title, SUM(amount) AS total
       FROM expenses
       GROUP BY title
       ORDER BY total DESC`
    );

    const [monthlyExpenses] = await pool.query(
      `SELECT DATE_FORMAT(expense_date,'%Y-%m') AS month,
              SUM(amount) AS total
       FROM expenses
       GROUP BY month
       ORDER BY month`
    );

    /* ===== DAMAGE ===== */
    const [[damageTotal]] = await pool.query(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(amount), 0) AS total,
              COALESCE(SUM(CASE WHEN payment_status = 'PAID' THEN amount ELSE 0 END), 0) AS paid_total,
              COALESCE(SUM(CASE WHEN payment_status = 'UNPAID' THEN amount ELSE 0 END), 0) AS unpaid_total
       FROM damage_bills`
    );

    const [damageByJetski] = await pool.query(
      `SELECT IFNULL(service_name,'Unknown') AS service,
              SUM(amount) AS total
       FROM damage_bills
       GROUP BY service
       ORDER BY total DESC`
    );

    const [monthlyDamage] = await pool.query(
      `SELECT DATE_FORMAT(incident_date,'%Y-%m') AS month,
              SUM(amount) AS total
       FROM damage_bills
       GROUP BY month
       ORDER BY month`
    );

    /* ===== PROFIT ===== */
    // Exclude output VAT from invoice revenue and count extension revenue only
    // after an approved extension is marked paid. Supported recoverable input VAT
    // is excluded from expenses using the same evidence criteria as the finance report.
    const profit = Number((
      Number(allInvoicesTotal.total || 0) +
      Number(paidExtensionsTotal.total || 0) +
      Number(damageTotal.paid_total || 0) -
      Number(operatingExpensesTotal.total || 0)
    ).toFixed(2));
  
  

    res.json({
      today_customers: todayCustomers.count,
      new_customers_today: todayCustomers.count,
      today_invoices: todayInvoices.count,
      today_total_amount: todayInvoices.total,
      top_service_today: topServiceToday?.name || null,
      new_customers_week: newCustomersWeek.count,
      inactive_customers: inactiveCustomers.count,
      frequent_customers: frequentCustomers,
      sessions: {
        today: todaySessions,
        active: activeSessions,
        active_list: activeSessionList,
        pending_delay_acknowledgements: pendingDelayAcknowledgements.count,
        delay_trends_last_7_days: delayTrends,
        delays_by_reason_last_7_days: delaysByReason,
        timing_last_7_days: {
          completed_sessions: sessionTiming.completed_sessions,
          on_time_sessions: sessionTiming.on_time_sessions,
          on_time_rate: onTimeRate
        },
        extensions: extensionTracking
      },
      latest_review: latestReview || null,
      sales_last_7_days: salesLast7Days,
      top_services_month: topServicesMonth,
      monthly_sales: monthlySalesFormatted,
      yearly_sales: yearlySales,
    
      expenses: {
        count: expensesTotal.count,
        total: expensesTotal.total,
        by_title: expensesByTitle,
        monthly: monthlyExpenses
      },
    
      damage: {
        count: damageTotal.count,
        total: damageTotal.total,
        paid_total: damageTotal.paid_total,
        unpaid_total: damageTotal.unpaid_total,
        by_jetski: damageByJetski,
        monthly: monthlyDamage
      },
    
      profit, // ✅ ADD THIS LINE
    
      totals: {
        invoices: allInvoicesTotal.total,
        expenses: expensesTotal.total,
        profit
      }
    });
    

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
