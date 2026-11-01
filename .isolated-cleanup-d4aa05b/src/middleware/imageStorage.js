const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, S3Client } = require("@aws-sdk/client-s3");

const uploadDirectory = path.resolve(__dirname, "..", "..", "uploads");
const r2Values = [
  process.env.R2_ENDPOINT,
  process.env.R2_ACCESS_KEY_ID,
  process.env.R2_SECRET_ACCESS_KEY,
  process.env.R2_BUCKET_NAME,
];
const r2Configured = r2Values.every(Boolean);
const r2PartiallyConfigured = r2Values.some(Boolean) && !r2Configured;
const requestedStorageMode = process.env.UPLOAD_STORAGE;
const storageMode = requestedStorageMode || (process.env.NODE_ENV === "production" || r2Configured ? "r2" : "local");

if (!["local", "r2"].includes(storageMode)) {
  throw new Error("UPLOAD_STORAGE must be either local or r2");
}

const r2 = r2Configured
  ? new S3Client({
      endpoint: process.env.R2_ENDPOINT,
      region: "auto",
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    })
  : null;

function createFilename(originalName) {
  const extension = path.extname(originalName).toLowerCase().replace(/[^.a-z0-9]/g, "");
  return `${Date.now()}-${crypto.randomUUID()}${extension}`;
}

async function saveUpload(file) {
  const filename = createFilename(file.originalname || "image");

  if (storageMode === "r2") {
    if (!r2Configured) {
      const error = new Error(r2PartiallyConfigured
        ? "Cloudflare R2 storage configuration is incomplete. Set the R2 endpoint, access key, secret key, and bucket."
        : "Cloudflare R2 storage is not configured. Add the R2 environment variables before uploading.");
      error.statusCode = 503;
      throw error;
    }

    try {
      await r2.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: filename,
        Body: file.buffer,
        ContentType: file.mimetype || "application/octet-stream",
      }));
    } catch (error) {
      const storageError = new Error("Could not store the uploaded image in Cloudflare R2.");
      storageError.statusCode = 502;
      storageError.cause = error;
      throw storageError;
    }
  } else {
    await fs.promises.mkdir(uploadDirectory, { recursive: true });
    await fs.promises.writeFile(path.join(uploadDirectory, filename), file.buffer);
  }

  file.filename = filename;
  return filename;
}

async function readUpload(filename) {
  if (r2) {
    try {
      const result = await r2.send(new GetObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: filename,
      }));
      const bytes = await result.Body.transformToByteArray();
      return { buffer: Buffer.from(bytes), contentType: result.ContentType };
    } catch (error) {
      if (error.name !== "NoSuchKey" && error.$metadata?.httpStatusCode !== 404) throw error;
    }
  }

  const filePath = path.resolve(uploadDirectory, filename);
  if (!filePath.startsWith(uploadDirectory + path.sep)) return null;
  try {
    return { buffer: await fs.promises.readFile(filePath), contentType: undefined };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function validateStoredFilename(filename) {
  if (typeof filename !== "string" || !filename || path.basename(filename) !== filename || filename.includes("\\")) {
    throw new Error("Invalid stored file name");
  }
}

async function deleteUpload(filename, mode) {
  if (!filename) return;

  validateStoredFilename(filename);

  // Keep the original one-argument behavior for upload rollback callers.
  const deleteR2 = mode === "r2" || (mode === undefined && Boolean(r2));
  const deleteLocal = mode === "local" || mode === undefined;

  if (mode !== undefined && !["local", "r2"].includes(mode)) {
    throw new Error("Invalid stored file mode");
  }

  if (deleteR2) {
    if (!r2Configured) {
      const error = new Error("Cloudflare R2 storage is not configured for queued file cleanup.");
      error.code = "R2_NOT_CONFIGURED";
      throw error;
    }
    await r2.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: filename }));
  }

  if (deleteLocal) {
    const filePath = path.resolve(uploadDirectory, filename);
    if (filePath.startsWith(uploadDirectory + path.sep)) {
      await fs.promises.rm(filePath, { force: true });
    }
  }
}

module.exports = { saveUpload, readUpload, deleteUpload, r2Configured, storageMode, r2 };
