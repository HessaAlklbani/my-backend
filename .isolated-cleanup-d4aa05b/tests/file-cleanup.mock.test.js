const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");

process.env.DB_HOST = "127.0.0.1";
process.env.DB_USER = "mock";
process.env.DB_PASSWORD = "mock";
process.env.DB_NAME = "mock";
process.env.NODE_ENV = "production";
process.env.UPLOAD_STORAGE = "r2";
process.env.R2_ENDPOINT = "https://mock-account.r2.cloudflarestorage.com";
process.env.R2_ACCESS_KEY_ID = "mock-key";
process.env.R2_SECRET_ACCESS_KEY = "mock-secret";
process.env.R2_BUCKET_NAME = "mock-bucket";
process.env.DASHBOARD_PASSWORD = "mock-dashboard-password";
process.env.CORS_ORIGINS = "http://allowed.example";
process.env.PORT = "0";
delete process.env.R2_ACCOUNT_ID;

const pool = require("../src/config/db");
const storage = require("../src/middleware/imageStorage");
const cleanup = require("../src/middleware/fileCleanup");
const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const objects = new Map();
const deleteCalls = [];
let failNextDelete = false;
let workerStarted = false;
let capturedApp;
const state = {
  service: { id: 7, name: "Mock service", description: "", duration: 20, price: 1, image: "old-service.png", active: 1 },
  customer: { id: 4, eid_file: "shared-customer.png" },
  expense: null,
  damage: null,
  extraReferences: new Set(),
  queue: [],
  nextQueueId: 1,
  committed: false,
  attempts: 0,
};

for (const key of ["old-service.png", "shared-customer.png", "delete-service.png", "inactive-service.png"]) {
  objects.set(key, Buffer.from(`mock:${key}`));
}

storage.r2.send = async (command) => {
  if (command instanceof PutObjectCommand) {
    objects.set(command.input.Key, Buffer.from(command.input.Body));
    return {};
  }
  if (command instanceof GetObjectCommand) {
    const body = objects.get(command.input.Key);
    if (!body) {
      const error = new Error("missing mock object");
      error.name = "NoSuchKey";
      throw error;
    }
    return { Body: { transformToByteArray: async () => body }, ContentLength: body.length, ContentType: "image/png" };
  }
  if (command instanceof DeleteObjectCommand) {
    deleteCalls.push(command.input.Key);
    if (failNextDelete) {
      failNextDelete = false;
      const error = new Error("mock delete denied");
      error.code = "AccessDenied";
      throw error;
    }
    objects.delete(command.input.Key);
    return {};
  }
  throw new Error("Unexpected mock storage operation");
};

const connection = {
  beginTransaction: async () => { state.committed = false; },
  commit: async () => { state.committed = true; },
  rollback: async () => { state.committed = false; },
  release: () => {},
  execute: async (sql, values) => {
    if (!sql.includes("INSERT INTO file_cleanup_queue")) throw new Error("Unexpected connection execute");
    state.queue.push({ id: state.nextQueueId++, storage_mode: values[0], object_key: values[1], attempts: 0 });
    return [{}];
  },
  query: async (sql, values) => {
    const query = sql.trimStart();
    if (query.startsWith("SELECT image FROM services")) return [[...(state.service ? [{ image: state.service.image }] : [])]];
    if (query.startsWith("UPDATE services SET name")) { state.service.image = values[4]; return [{}]; }
    if (query.startsWith("DELETE FROM services")) { state.service = null; return [{ affectedRows: 1 }]; }
    if (query.startsWith("SELECT eid_file FROM customers")) return [[...(state.customer ? [{ eid_file: state.customer.eid_file }] : [])]];
    if (query.startsWith("UPDATE customers SET")) { state.customer.eid_file = values[3]; return [{}]; }
    if (query.startsWith("DELETE FROM customers")) { state.customer = null; return [{ affectedRows: 1 }]; }
    if (query.startsWith("SELECT bill_image FROM expenses")) return [[...(state.expense ? [{ bill_image: state.expense.bill_image }] : [])]];
    if (query.startsWith("UPDATE expenses")) {
      const imageIndex = query.includes(", bill_image=?") ? values.length - 2 : -1;
      if (imageIndex >= 0) state.expense.bill_image = values[imageIndex];
      return [{}];
    }
    if (query.startsWith("DELETE FROM expenses")) { state.expense = null; return [{ affectedRows: 1 }]; }
    if (query.startsWith("SELECT damage_images FROM damage_bills")) return [[...(state.damage ? [{ damage_images: state.damage.damage_images }] : [])]];
    if (query.startsWith("UPDATE damage_bills")) {
      if (query.includes(", damage_images=?")) state.damage.damage_images = values[values.length - 2];
      return [{}];
    }
    if (query.startsWith("DELETE FROM damage_bills")) { state.damage = null; return [{ affectedRows: 1 }]; }
    throw new Error(`Unexpected connection query: ${sql.slice(0, 50)}`);
  },
};

pool.getConnection = async () => connection;
pool.query = async (sql, values = []) => {
  if (sql.includes("FROM file_cleanup_queue")) return [state.queue.map((task) => ({ ...task }))];
  if (sql.includes("SELECT id, name, description, duration, price, image FROM services WHERE active = true")) {
    return [[...(state.service && state.service.active ? [{ ...state.service }] : [])]];
  }
  if (sql.includes("SELECT active FROM services")) return [state.service ? [{ active: state.service.active }] : []];
  if (sql.includes("UPDATE services SET active = ?")) {
    if (state.service) state.service.active = values[0];
    return [{ affectedRows: 1 }];
  }
  if (sql.includes("SELECT eid_file FROM customers WHERE id = ?")) return [state.customer ? [{ eid_file: state.customer.eid_file }] : []];
  if (sql.includes("SELECT * FROM expenses ORDER BY expense_date")) return [[...(state.expense ? [{ ...state.expense }] : [])]];
  if (sql.includes("SELECT * FROM damage_bills ORDER BY incident_date")) return [[...(state.damage ? [{ ...state.damage }] : [])]];
  if (sql.includes("SELECT 1 FROM services WHERE image = ?")) {
    const filename = values[0];
    const isPubliclyReferenced = state.service?.image === filename || state.expense?.bill_image === filename ||
      String(state.damage?.damage_images || "").split(",").includes(filename) || state.extraReferences.has(filename);
    return [isPubliclyReferenced ? [{ referenced: 1 }] : []];
  }
  if (sql.includes("FROM expenses ORDER BY expense_date")) return [[]];
  if (sql.includes("FROM damage_bills ORDER BY incident_date")) return [[]];
  throw new Error(`Unexpected pool query: ${sql.slice(0, 70)}`);
};

pool.execute = async (sql, values = []) => {
  if (sql.includes("SELECT 1 AS referenced")) return [isReferenced(values[0]) ? [{ referenced: 1 }] : []];
  if (sql.startsWith("DELETE FROM file_cleanup_queue")) {
    state.queue = state.queue.filter((task) => task.id !== values[0]);
    return [{ affectedRows: 1 }];
  }
  if (sql.includes("UPDATE file_cleanup_queue")) {
    state.attempts += 1;
    const task = state.queue.find((item) => item.id === values[1]);
    if (task) task.attempts += 1;
    return [{ affectedRows: 1 }];
  }
  throw new Error(`Unexpected pool execute: ${sql.slice(0, 60)}`);
};

function isReferenced(filename) {
  return state.service?.image === filename || state.customer?.eid_file === filename ||
    state.expense?.bill_image === filename || String(state.damage?.damage_images || "").split(",").includes(filename) ||
    state.extraReferences.has(filename);
}

async function main() {
  assert.equal(storage.storageMode, "r2");
  assert.equal(storage.r2Configured, true);
  assert.equal(process.env.R2_ACCOUNT_ID, undefined);
  const endpoint = await storage.r2.config.endpoint();
  assert.equal(endpoint.hostname, "mock-account.r2.cloudflarestorage.com", "R2_ENDPOINT is used");
  state.expense = { bill_image: "shared-expense.png" };
  assert.equal(await cleanup.isFileReferenced("shared-expense.png"), true, "expense receipt references are checked");
  state.expense = null;
  state.damage = { damage_images: "one.png,shared-damage.png,two.png" };
  assert.equal(await cleanup.isFileReferenced("shared-damage.png"), true, "damage image list references are checked");
  state.damage = null;

  const originalStart = cleanup.startFileCleanupWorker;
  cleanup.startFileCleanupWorker = () => { workerStarted = true; };
  const originalListen = express.application.listen;
  express.application.listen = function () { capturedApp = this; return {}; };
  require("../src/app");
  express.application.listen = originalListen;
  assert.equal(workerStarted, true, "app starts the cleanup worker");
  assert.ok(capturedApp);
  cleanup.startFileCleanupWorker = originalStart;

  const originalSetInterval = global.setInterval;
  const originalSetImmediate = global.setImmediate;
  let scheduledInterval;
  let initialQueueRun;
  let intervalUnreferenced = false;
  global.setInterval = (callback, delay) => {
    scheduledInterval = { callback, delay, unref() { intervalUnreferenced = true; } };
    return scheduledInterval;
  };
  global.setImmediate = (callback) => { initialQueueRun = callback; return 1; };
  cleanup.startFileCleanupWorker();
  assert.equal(scheduledInterval.delay, 60 * 1000, "worker retries once per minute");
  assert.equal(intervalUnreferenced, true, "worker timer does not keep the process alive");
  assert.equal(typeof initialQueueRun, "function", "worker schedules an immediate initial pass");
  global.setInterval = originalSetInterval;
  global.setImmediate = originalSetImmediate;

  const server = http.createServer(capturedApp);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const form = new FormData();
  for (const [key, value] of Object.entries({ name: "Mock service", description: "", duration: "20", price: "1" })) {
    form.append(key, value);
  }
  form.append("image", new Blob(["replacement bytes"], { type: "image/png" }), "replacement.png");
  const replace = await fetch(`${base}/api/services/7`, { method: "PUT", body: form });
  assert.equal(replace.status, 200, "existing service update API remains available");
  assert.equal(state.committed, true);
  assert.equal(objects.has("old-service.png"), false, "old service image is removed after commit");
  const replacementName = state.service.image;
  assert.ok(objects.has(replacementName), "new service image remains stored");
  const replacementView = await fetch(`${base}/uploads/${encodeURIComponent(replacementName)}`);
  assert.equal(replacementView.status, 200, "uploaded service image remains viewable");
  assert.equal(await replacementView.text(), "replacement bytes");

  state.service.image = "delete-service.png";
  failNextDelete = true;
  const remove = await fetch(`${base}/api/services/7`, { method: "DELETE" });
  assert.equal(remove.status, 200, "existing service delete API remains available");
  assert.ok(objects.has("delete-service.png"), "failed R2 deletion does not destroy data");
  assert.equal(state.queue.length, 1, "failed deletion remains queued");
  assert.equal(state.attempts, 1, "failed deletion is recorded for retry");
  await cleanup.processFileCleanupQueue();
  assert.equal(objects.has("delete-service.png"), false, "retry removes the unreferenced R2 object");
  assert.equal(state.queue.length, 0);

  state.service = { id: 7, image: "shared-customer.png", active: 1 };
  const sharedRemove = await fetch(`${base}/api/services/7`, { method: "DELETE" });
  assert.equal(sharedRemove.status, 200);
  assert.ok(objects.has("shared-customer.png"), "customer reference prevents object deletion");
  assert.equal(deleteCalls.includes("shared-customer.png"), false);

  state.service = { id: 7, image: "inactive-service.png", active: 1 };
  const queueBeforeToggle = state.queue.length;
  const toggle = await fetch(`${base}/api/services/7/toggle`, { method: "PATCH" });
  assert.equal(toggle.status, 200);
  assert.equal(state.service.active, 0);
  assert.ok(objects.has("inactive-service.png"), "inactive service image is retained");
  assert.equal(state.queue.length, queueBeforeToggle);

  const unauthorized = await fetch(`${base}/api/customers/4/eid`);
  assert.equal(unauthorized.status, 401, "customer ID route remains authenticated");
  const eid = await fetch(`${base}/api/customers/4/eid`, { headers: { "x-dashboard-password": process.env.DASHBOARD_PASSWORD } });
  assert.equal(eid.status, 200);
  assert.equal(eid.headers.get("cache-control"), "private, no-store");
  assert.match(await eid.text(), /mock:shared-customer/);
  assert.equal((await fetch(`${base}/uploads/shared-customer.png`)).status, 404, "customer files are not public");

  objects.set("old-eid.png", Buffer.from("old EID"));
  state.customer.eid_file = "old-eid.png";
  const eidForm = new FormData();
  eidForm.append("full_name", "Mock Customer");
  eidForm.append("phone", "0000000000");
  eidForm.append("nationality", "Mock");
  eidForm.append("eid", new Blob(["new EID"], { type: "image/png" }), "eid.png");
  const eidReplace = await fetch(`${base}/api/customers/4`, { method: "PUT", body: eidForm });
  assert.equal(eidReplace.status, 200, "customer EID replacement route succeeds");
  assert.equal(objects.has("old-eid.png"), false, "replaced customer EID is cleaned after commit");
  objects.set("delete-eid.png", Buffer.from("delete EID"));
  state.customer.eid_file = "delete-eid.png";
  const eidDelete = await fetch(`${base}/api/customers/4`, { method: "DELETE" });
  assert.equal(eidDelete.status, 200);
  assert.equal(objects.has("delete-eid.png"), false, "deleted customer EID is cleaned");

  objects.set("old-receipt.png", Buffer.from("old receipt"));
  state.expense = { id: 11, bill_image: "old-receipt.png" };
  const expenseForm = new FormData();
  expenseForm.append("title", "Mock expense");
  expenseForm.append("amount", "12");
  expenseForm.append("expense_date", "2026-11-01");
  expenseForm.append("bill_image", new Blob(["new receipt"], { type: "image/png" }), "receipt.png");
  const expenseReplace = await fetch(`${base}/api/expenses/11`, { method: "PUT", body: expenseForm });
  const expenseReplaceText = await expenseReplace.text();
  assert.equal(expenseReplace.status, 200, `expense receipt replacement route succeeds: ${expenseReplaceText}`);
  assert.equal(objects.has("old-receipt.png"), false, "replaced expense receipt is cleaned");
  objects.set("delete-receipt.png", Buffer.from("delete receipt"));
  state.expense.bill_image = "delete-receipt.png";
  const expenseDelete = await fetch(`${base}/api/expenses/11`, { method: "DELETE" });
  assert.equal(expenseDelete.status, 200, "expense receipt deletion route succeeds");
  assert.equal(objects.has("delete-receipt.png"), false, "deleted expense receipt is cleaned");

  objects.set("old-damage.png", Buffer.from("old damage"));
  state.damage = { id: 12, damage_images: "old-damage.png" };
  const damageForm = new FormData();
  for (const [key, value] of Object.entries({ customer_name: "Mock", customer_number: "000", service_name: "Mock", description: "", amount: "1", incident_date: "2026-11-01", created_by: "Mock" })) damageForm.append(key, value);
  damageForm.append("damage_images", new Blob(["new damage"], { type: "image/png" }), "damage.png");
  const damageReplace = await fetch(`${base}/api/damage/12`, { method: "PUT", body: damageForm });
  assert.equal(damageReplace.status, 200, "damage photo replacement route succeeds");
  assert.equal(objects.has("old-damage.png"), false, "replaced damage photo is cleaned");
  objects.set("delete-damage.png", Buffer.from("delete damage"));
  state.damage.damage_images = "delete-damage.png";
  const damageDelete = await fetch(`${base}/api/damage/12`, { method: "DELETE" });
  assert.equal(damageDelete.status, 200, "damage photo deletion route succeeds");
  assert.equal(objects.has("delete-damage.png"), false, "deleted damage photo is cleaned");

  assert.equal((await fetch(`${base}/api/services`)).status, 200);
  assert.equal((await fetch(`${base}/api/expenses/all`)).status, 200);
  assert.equal((await fetch(`${base}/api/damage/all`)).status, 200);
  const publicServiceImage = await fetch(`${base}/uploads/inactive-service.png`);
  assert.equal(publicServiceImage.status, 200, "service images remain viewable through existing endpoint");
  const blockedOrigin = await fetch(`${base}/`, { headers: { Origin: "http://blocked.example" } });
  assert.equal(blockedOrigin.status, 500);
  assert.equal((await blockedOrigin.json()).message, "Request failed", "deployed error middleware remains active");
  assert.equal(await (await fetch(`${base}/`)).text(), "Backend is running");

  await new Promise((resolve) => server.close(resolve));
  console.log("PASS: R2_ENDPOINT compatibility; service replacement/deletion; shared reference protection; inactive retention; retry; worker startup; authenticated customer document; existing routes; error middleware; upload and viewing mocks");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
