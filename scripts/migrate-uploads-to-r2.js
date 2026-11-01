require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");
const { HeadObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { client, bucket } = require("../src/config/r2");

const sourceDirectory = path.resolve(
  process.argv[2] || path.join(__dirname, "..", "uploads")
);

const contentTypes = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function isMissingObject(error) {
  return error?.$metadata?.httpStatusCode === 404 ||
    error?.name === "NotFound" ||
    error?.Code === "NoSuchKey";
}

async function migrate() {
  if (path.basename(sourceDirectory).toLowerCase() !== "uploads") {
    throw new Error("Pass the path to the backed-up uploads folder.");
  }

  const entries = await fs.readdir(sourceDirectory, { withFileTypes: true });
  if (entries.some((entry) => entry.isDirectory())) {
    throw new Error("The uploads folder contains nested directories; migration stopped to preserve database filenames.");
  }

  const files = entries.filter((entry) => entry.isFile());
  let uploaded = 0;
  let skipped = 0;

  for (const entry of files) {
    const key = entry.name;
    let exists = false;

    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      exists = true;
    } catch (error) {
      if (!isMissingObject(error)) throw error;
    }

    if (exists) {
      skipped += 1;
      continue;
    }

    const filePath = path.join(sourceDirectory, key);
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: await fs.readFile(filePath),
      ContentType: contentTypes[path.extname(key).toLowerCase()] || "application/octet-stream",
      CacheControl: "private, no-store",
    }));
    uploaded += 1;
  }

  console.log(`R2 upload migration finished. Uploaded: ${uploaded}. Already present: ${skipped}. Total files checked: ${files.length}.`);
}

migrate().catch((error) => {
  console.error(`R2 upload migration failed (${error.name || "Error"}). No filenames or credentials were printed.`);
  process.exitCode = 1;
});
