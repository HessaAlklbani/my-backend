module.exports = function (req, res, next) {
    const password = req.headers["x-dashboard-password"];
  
    if (!password) {
      return res.status(401).json({ message: "Password required" });
    }
  
    if (password !== process.env.DASHBOARD_PASSWORD) {
      return res.status(403).json({ message: "Access denied" });
    }
  
    next();
  };
  