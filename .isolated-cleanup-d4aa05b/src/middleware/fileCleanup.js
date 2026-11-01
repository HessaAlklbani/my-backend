const pool = require("../config/db");
const { deleteUpload, storageMode } = require("./imageStorage");

function validateStoredFilename(filename) {
  const path = require("path");
  if (typeof filename !== "string" || !filename || path.basename(filename) !== filename || filename.includes("\\")) {
    throw new Error("Invalid stored file name");
  }
}

async function enqueueFileCleanup(connection, filenames) {
  const uniqueNames = [...new Set((filenames || []).filter(Boolean))];
  for (const filename of uniqueNames) {
    validateStoredFilename(filename);
    await connection.execute(
      `INSERT INTO file_cleanup_queue (storage_mode, object_key)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE next_attempt_at = LEAST(next_attempt_at, CURRENT_TIMESTAMP)`,
      [storageMode, filename]
    );
  }
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
  await deleteUpload(filename, mode);
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

async function processFileCleanupQueueSafely() {
  try {
    await processFileCleanupQueue();
  } catch (error) {
    console.error("Stored file cleanup queue is unavailable", error.code || error.name || "QUEUE_ERROR");
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
  await processFileCleanupQueueSafely();
}

async function scheduleOrphanedUploads(filenames) {
  const uniqueNames = [...new Set((filenames || []).filter(Boolean))];
  if (!uniqueNames.length) return;

  try {
    await scheduleFileCleanup(uniqueNames);
  } catch (queueError) {
    console.error("Could not queue uploaded file cleanup", queueError.code || queueError.name || "QUEUE_ERROR");
    for (const filename of uniqueNames) {
      await deleteIfUnreferenced(filename).catch((deleteError) => {
        console.error("Unreferenced upload cleanup failed", deleteError.code || deleteError.name || "DELETE_FAILED");
      });
    }
  }
}

function startFileCleanupWorker() {
  const timer = setInterval(processFileCleanupQueueSafely, 60 * 1000);
  timer.unref();
  setImmediate(processFileCleanupQueueSafely);
  return timer;
}

module.exports = {
  enqueueFileCleanup,
  isFileReferenced,
  deleteIfUnreferenced,
  processFileCleanupQueue,
  processFileCleanupQueueSafely,
  scheduleFileCleanup,
  scheduleOrphanedUploads,
  startFileCleanupWorker,
};
