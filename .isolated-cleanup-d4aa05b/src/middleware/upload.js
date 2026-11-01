const multer = require("multer");
const { saveUpload, deleteUpload } = require("./imageStorage");

const parser = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

function persist(method, ...args) {
  const parseFiles = parser[method](...args);
  return (req, res, next) => {
    parseFiles(req, res, async (error) => {
      if (error) return next(error);

      try {
        const files = req.file ? [req.file] : (req.files || []);
        const savedFiles = [];
        try {
          for (const file of files) {
            await saveUpload(file);
            savedFiles.push(file.filename);
          }
        } catch (uploadError) {
          await Promise.allSettled(savedFiles.map((filename) => deleteUpload(filename)));
          throw uploadError;
        }
        return next();
      } catch (uploadError) {
        return next(uploadError);
      }
    });
  };
}

module.exports = {
  single: (...args) => persist("single", ...args),
  array: (...args) => persist("array", ...args),
};
