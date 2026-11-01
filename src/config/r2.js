const { S3Client } = require("@aws-sdk/client-s3");

const required = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
];
const missing = required.filter((key) => !process.env[key]);

if (missing.length) {
  throw new Error(`Missing required R2 environment variables: ${missing.join(", ")}`);
}

const bucket = process.env.R2_BUCKET_NAME;
const client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

module.exports = { client, bucket };
