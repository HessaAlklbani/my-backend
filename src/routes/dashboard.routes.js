const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const dashboardAuth = require("../middleware/dashboardAuth");

/* 🔐 LOGIN CHECK */
router.post("/login", (req, res) => {
  const password = req.headers["x-dashboard-password"];
  if (!password) return res.status(401).json({ message: "Password required" });
  if (password !== process.env.DASHBOARD_PASSWORD) return res.status(403).json({ message: "Invalid password" });
  res.json({ success: true });
});

/* 📊 FULL DASHBOARD STATUS */
router.get("/status", dashboardAuth, async (req, res) => {
  try {
    // اليوم
    const [[todayCustomers]] = await pool.query(
      `SELECT COUNT(*) AS count FROM customers WHERE DATE(created_at)=CURDATE()`
    );
    const [[todayInvoices]] = await pool.query(
      `SELECT COUNT(*) AS count, IFNULL(SUM(total_amount),0) AS total
       FROM invoices WHERE DATE(created_at)=CURDATE()`
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

    // العملاء الجدد هذا الأسبوع
    const [[newCustomersWeek]] = await pool.query(
      `SELECT COUNT(*) AS count FROM customers
       WHERE YEARWEEK(created_at, 1) = YEARWEEK(CURDATE(), 1)`
    );

    // العملاء غير النشطين (>30 يوم)
    const [inactiveCustomers] = await pool.query(
      `SELECT COUNT(*) AS count FROM customers c
       LEFT JOIN invoices i ON i.customer_id = c.id
       WHERE i.id IS NULL OR DATEDIFF(CURDATE(), i.created_at) > 30`
    );

    // العملاء المنتظمين (زيارتين+ في آخر 30 يوم)
    const [frequentCustomers] = await pool.query(
      `SELECT 
      c.phone, 
      MIN(c.full_name) AS full_name, 
      COUNT(i.id) AS visits
      FROM customers c
      JOIN invoices i ON i.customer_id = c.id
      WHERE i.created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
      GROUP BY c.phone
      HAVING visits >= 2
      ORDER BY visits DESC`
    ); 

    // آخر مراجعة
    const [[latestReview]] = await pool.query(
      `SELECT full_name, message, created_at
       FROM reviews
       ORDER BY created_at DESC
       LIMIT 1`
    );

    // مبيعات الأيام الأخيرة (7 أيام)
    const [salesLast7Days] = await pool.query(
      `SELECT DATE(created_at) AS date, IFNULL(SUM(total_amount),0) AS total
       FROM invoices
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
       GROUP BY DATE(created_at)
       ORDER BY DATE(created_at)`
    );

    // الخدمات الأكثر مبيعًا (آخر 30 يوم)
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

    // المبيعات الشهرية (السنة الحالية)
    const [monthlySales] = await pool.query(
      `SELECT MONTH(created_at) AS month, IFNULL(SUM(total_amount),0) AS total
       FROM invoices
       WHERE YEAR(created_at) = YEAR(CURDATE())
       GROUP BY MONTH(created_at)
       ORDER BY MONTH(created_at)`
    );
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const monthlySalesFormatted = monthlySales.map(m => ({
      month: monthNames[m.month - 1],
      total: m.total
    }));

    // المبيعات السنوية
    const [yearlySales] = await pool.query(
      `SELECT YEAR(created_at) AS year, IFNULL(SUM(total_amount),0) AS total
       FROM invoices
       GROUP BY YEAR(created_at)
       ORDER BY YEAR(created_at)`
    );

    res.json({
      today_customers: todayCustomers.count,
      today_invoices: todayInvoices.count,
      today_total_amount: todayInvoices.total,
      top_service_today: topServiceToday ? topServiceToday.name : null,
      new_customers_week: newCustomersWeek.count,
      inactive_customers: inactiveCustomers[0].count,
      frequent_customers: frequentCustomers,
      latest_review: latestReview || null,
      sales_last_7_days: salesLast7Days,
      top_services_month: topServicesMonth,
      monthly_sales: monthlySalesFormatted,
      yearly_sales: yearlySales
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
