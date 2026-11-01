require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const pool = require("./config/db");
const { readUpload } = require("./middleware/imageStorage");
const fileCleanup = require("./middleware/fileCleanup");

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
// Only service, damage, and expense images are available through this route.
// Customer ID images are served separately behind dashboard authentication.
app.get("/uploads/:filename", async (req, res, next) => {
  const filename = req.params.filename;
  if (!filename || path.basename(filename) !== filename) return res.status(404).end();

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

    const file = await readUpload(filename);
    if (!file) return res.status(404).end();
    if (file.contentType) res.type(file.contentType);
    res.set("Cache-Control", "public, max-age=3600");
    return res.send(file.buffer);
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

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  console.error("Request failed:", error);
  return res.status(error.statusCode || (error.code === "LIMIT_FILE_SIZE" ? 413 : 500)).json({
    message: error.statusCode === 503
      ? error.message
      : error.code === "LIMIT_FILE_SIZE"
        ? "Uploaded file exceeds the 10 MB limit"
        : "Request failed",
  });
});





app.get("/", (req, res) => {
  res.send("Backend is running");
});

const PORT = process.env.PORT || 4000;
fileCleanup.startFileCleanupWorker();
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
