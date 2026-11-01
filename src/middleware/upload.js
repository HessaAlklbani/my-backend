const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const pool = require("../config/db");

const uploadDirectory = path.resolve(__dirname, "..", "..", "uploads");
const storageMode = process.env.UPLOAD_STORAGE || (process.env.NODE_ENV === "production" ? "r2" : "local");

if (!["local", "r2"].includes(storageMode)) {
  throw new Error("UPLOAD_STORAGE must be either local or r2");
}

const isR2 = storageMode === "r2";
const r2 = isR2 ? require("../config/r2") : null;

if (!isR2) {
  fs.mkdirSync(uploadDirectory, { recursive: true });
}

const localStorage = multer.diskStorage({
  destination: uploadDirectory,
  filename: (req, file, cb) => cb(null, makeFilename(file.originalname)),
});

function makeFilename(originalname) {
  const extension = path.extname(originalname).toLowerCase().replace(/[^.a-z0-9]/g, "");
  return `${Date.now()}-${crypto.randomUUID()}${extension}`;
}

function isMissingObject(error) {
  return error?.$metadata?.httpStatusCode === 404 ||
    error?.name === "NotFound" ||
    error?.Code === "NoSuchKey";
}

function validateStoredName(filename) {
  if (typeof filename !== "string" || !filename || path.basename(filename) !== filename || filename.includes("\\")) {
    throw new Error("Invalid stored file name");
  }
}

const parser = multer({
  storage: isR2 ? multer.memoryStorage() : localStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
});

async function persistR2Files(files) {
  const uploaded = [];

  try {
    for (const file of files) {
      const filename = makeFilename(file.originalname);
      await r2.client.send(new PutObjectCommand({
        Bucket: r2.bucket,
        Key: filename,
        Body: file.buffer,
        ContentType: file.mimetype || "application/octet-stream",
        CacheControl: "private, no-store",
      }));
      file.filename = filename;
      file.key = filename;
      delete file.buffer;
      uploaded.push(filename);
    }
  } catch (error) {
    await Promise.allSettled(uploaded.map((Key) => r2.client.send(
      new DeleteObjectCommand({ Bucket: r2.bucket, Key })
    )));
    error.code = error.code || "R2_UPLOAD_FAILED";
    error.statusCode = 502;
    throw error;
  }
}

function withStorage(parserMiddleware) {
  return (req, res, next) => parserMiddleware(req, res, (error) => {
    if (error) return next(error);
    if (!isR2) return next();

    const files = req.file ? [req.file] : (req.files || []);
    persistR2Files(files).then(() => next()).catch(next);
  });
}

async function sendStoredFile(filename, res, next) {
  validateStoredName(filename);

  if (!isR2) {
    const filePath = path.resolve(uploadDirectory, filename);
    return new Promise((resolve, reject) => {
      res.sendFile(filePath, (error) => {
        if (!error) return resolve();
        if (error.statusCode === 404) return resolve(res.status(404).end());
        if (next) {
          next(error);
          return resolve();
        }
        return reject(error);
      });
    });
  }

  let object;
  try {
    object = await r2.client.send(new GetObjectCommand({
      Bucket: r2.bucket,
      Key: filename,
    }));
  } catch (error) {
    if (isMissingObject(error)) return res.status(404).end();
    throw error;
  }

  if (object.ContentType) res.setHeader("Content-Type", object.ContentType);
  if (object.ContentLength !== undefined) res.setHeader("Content-Length", object.ContentLength);
  res.setHeader("Cache-Control", "private, no-store");
  object.Body.on("error", (error) => {
    if (next && !res.headersSent) return next(error);
    res.destroy(error);
  });
  object.Body.pipe(res);
}

async function deleteStoredFile(filename, mode = storageMode) {
  if (!filename) return;
  validateStoredName(filename);

  if (mode === "r2") {
    const r2Config = r2 || require("../config/r2");
    await r2Config.client.send(new DeleteObjectCommand({
      Bucket: r2Config.bucket,
      Key: filename,
    }));
    return;
  }

  if (mode !== "local") throw new Error("Invalid stored file mode");

  try {
    await fs.promises.unlink(path.resolve(uploadDirectory, filename));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function enqueueFileCleanup(connection, filenames) {
  const uniqueNames = [...new Set((filenames || []).filter(Boolean))];
  for (const filename of uniqueNames) {
    validateStoredName(filename);
    await connection.execute(
      `INSERT INTO file_cleanup_queue (storage_mode, object_key)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE next_attempt_at = LEAST(next_attempt_at, CURRENT_TIMESTAMP)`,
      [storageMode, filename]
    );
  }
}

async function scheduleFileCleanup(filenames) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await enqueueFileCleanup(connection, filenames);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  await processFileCleanupQueue();
}

async function isFileReferenced(filename) {
  const [rows] = await pool.execute(
    `SELECT 1 AS referenced FROM services WHERE image = ?
     UNION ALL
     SELECT 1 FROM expenses WHERE bill_image = ?
     UNION ALL
     SELECT 1 FROM damage_bills WHERE FIND_IN_SET(?, damage_images) > 0
     UNION ALL
     SELECT 1 FROM customers WHERE eid_file = ?
     LIMIT 1`,
    [filename, filename, filename, filename]
  );
  return rows.length > 0;
}

async function deleteIfUnreferenced(filename, mode = storageMode) {
  if (await isFileReferenced(filename)) return false;
  await deleteStoredFile(filename, mode);
  return true;
}

async function processFileCleanupQueue() {
  const [tasks] = await pool.query(
    `SELECT id, storage_mode, object_key
     FROM file_cleanup_queue
     WHERE next_attempt_at <= CURRENT_TIMESTAMP
     ORDER BY id
     LIMIT 25`
  );

  for (const task of tasks) {
    try {
      if (!(await deleteIfUnreferenced(task.object_key, task.storage_mode))) {
        await pool.execute("DELETE FROM file_cleanup_queue WHERE id = ?", [task.id]);
        continue;
      }

      await pool.execute("DELETE FROM file_cleanup_queue WHERE id = ?", [task.id]);
    } catch (error) {
      await pool.execute(
        `UPDATE file_cleanup_queue
         SET attempts = attempts + 1,
             next_attempt_at = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 5 MINUTE),
             last_error_code = ?
         WHERE id = ?`,
        [String(error.code || error.name || "DELETE_FAILED").slice(0, 64), task.id]
      ).catch(() => {});
      console.error("Stored file cleanup will retry", {
        queueId: task.id,
        errorCode: error.code || error.name || "DELETE_FAILED",
      });
    }
  }
}

function startFileCleanupWorker() {
  const run = () => processFileCleanupQueue().catch((error) => {
    console.error("Stored file cleanup queue is unavailable", error.code || error.name || "QUEUE_ERROR");
  });
  const timer = setInterval(run, 60 * 1000);
  timer.unref();
  setImmediate(run);
}

module.exports = {
  single: (fieldName) => withStorage(parser.single(fieldName)),
  array: (fieldName, maxCount) => withStorage(parser.array(fieldName, maxCount)),
  sendStoredFile,
  deleteStoredFile,
  enqueueFileCleanup,
  scheduleFileCleanup,
  processFileCleanupQueue,
  startFileCleanupWorker,
  deleteIfUnreferenced,
  isR2,
  r2,
};
