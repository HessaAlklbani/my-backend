require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const pool = require("./config/db");
const upload = require("./middleware/upload");

const testDbRoute = require("./routes/test-db.routes");
const servicesRoutes = require("./routes/services.routes");
const customersRoutes = require("./routes/customers.routes");
const invoicesRoutes = require("./routes/invoices.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const reviewsRoutes = require("./routes/reviews.routes");
const expensesRoutes = require("./routes/expenses.routes");
const damageRoutes = require("./routes/damage.routes");
const serviceSessionsRoutes = require("./routes/serviceSessions.routes");






const app = express();

const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:3000,http://127.0.0.1:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin is not allowed by CORS"));
  },
  allowedHeaders: ["Content-Type", "Authorization", "x-dashboard-password"],
}));
app.use(express.json());
// Only images referenced by service records are public. Other uploads may
// contain customer IDs, receipts, or damage evidence.
app.get("/uploads/:filename", async (req, res, next) => {
  const filename = path.basename(req.params.filename);
  if (!filename || filename !== req.params.filename) return res.status(404).end();

  try {
    const [rows] = await pool.query(
      `SELECT 1 FROM services WHERE image = ?
       UNION ALL
       SELECT 1 FROM damage_bills WHERE FIND_IN_SET(?, damage_images) > 0
       UNION ALL
       SELECT 1 FROM expenses WHERE bill_image = ?
       LIMIT 1`,
      [filename, filename, filename]
    );
    if (!rows.length) return res.status(404).end();

    return await upload.sendStoredFile(filename, res, next);
  } catch (error) {
    return next(error);
  }
});
app.use(express.urlencoded({ extended: true })); // لتحليل form-urlencoded

app.use("/api", testDbRoute);
app.use("/api/services", servicesRoutes);
app.use("/api/customers", customersRoutes);
app.use("/api/invoices", invoicesRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/reviews", reviewsRoutes);
app.use("/api/expenses", expensesRoutes);
app.use("/api/damage", damageRoutes);
app.use("/api/serviceSessions", serviceSessionsRoutes);





app.get("/", (req, res) => {
  res.send("Backend is running");
});

upload.startFileCleanupWorker();

const PORT = process.env.PORT || 4000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
