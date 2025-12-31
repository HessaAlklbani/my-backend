const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "AHah161657",
  database: "watersport_db",
  waitForConnections: true,
  connectionLimit: 10,
});

module.exports = pool;
