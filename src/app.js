require("dotenv").config();
const express = require("express");
const cors = require("cors");

const testDbRoute = require("./routes/test-db.routes");
const servicesRoutes = require("./routes/services.routes");
const customersRoutes = require("./routes/customers.routes");
const invoicesRoutes = require("./routes/invoices.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const reviewsRoutes = require("./routes/reviews.routes");


const app = express();

app.use(cors());
app.use(express.json());
app.use("/uploads", express.static("uploads"));
app.use(express.urlencoded({ extended: true })); // لتحليل form-urlencoded

app.use("/api", testDbRoute);
app.use("/api/services", servicesRoutes);
app.use("/api/customers", customersRoutes);
app.use("/api/invoices", invoicesRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/reviews", reviewsRoutes);



app.get("/", (req, res) => {
  res.send("Backend is running");
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
