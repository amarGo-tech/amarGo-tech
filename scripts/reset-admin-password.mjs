// Reset a platform-admin password. The DB only stores a one-way PBKDF2 hash,
// so a forgotten password cannot be recovered - only replaced.
// Usage: node scripts/reset-admin-password.mjs <email> <newPassword>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import pg from "pg";

const [, , emailArg, newPassword] = process.argv;
if (!emailArg || !newPassword) {
  console.error("Usage: node scripts/reset-admin-password.mjs <email> <newPassword>");
  process.exit(1);
}
if (newPassword.length < 8) {
  console.error("Password must be at least 8 characters.");
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const p of [path.join(ROOT, "server/.env"), path.join(ROOT, ".env")]) {
    try {
      const m = fs.readFileSync(p, "utf8").match(/^\s*DATABASE_URL\s*=\s*"?([^"\n\r]+)"?/m);
      if (m) return m[1].trim();
    } catch {}
  }
  throw new Error("DATABASE_URL not found");
}

// same scheme as server/src/platform/auth/credentials.js
function hashPassword(password) {
  const iterations = 120000;
  const salt = randomBytes(16).toString("hex");
  const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("hex");
  return `pbkdf2$${iterations}$${salt}$${hash}`;
}

const email = emailArg.trim().toLowerCase();
const u = new URL(databaseUrl());
const client = new pg.Client({
  host: u.hostname,
  port: u.port ? Number(u.port) : 5432,
  user: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password),
  database: u.pathname.replace(/^\//, ""),
  ssl: { rejectUnauthorized: false },
});

try {
  await client.connect();

  const { rows } = await client.query(
    `SELECT u.id, u.email, u."fullName"
     FROM "users" u
     JOIN "user_roles" ur ON ur."userId" = u.id
     JOIN "roles" r ON r.id = ur."roleId"
     WHERE r.code = 'PLATFORM_ADMIN' AND lower(u.email) = $1`,
    [email],
  );

  if (!rows.length) {
    // help the caller find the right address
    const { rows: admins } = await client.query(
      `SELECT u.email FROM "users" u
       JOIN "user_roles" ur ON ur."userId" = u.id
       JOIN "roles" r ON r.id = ur."roleId"
       WHERE r.code = 'PLATFORM_ADMIN'`,
    );
    console.error(`No PLATFORM_ADMIN with email "${email}".`);
    console.error("Known admin emails:", admins.map((a) => a.email).join(", ") || "(none)");
    process.exit(1);
  }

  const admin = rows[0];
  await client.query(`UPDATE "users" SET "passwordHash" = $1, "updatedAt" = now() WHERE id = $2`, [
    hashPassword(newPassword),
    admin.id,
  ]);

  console.log(`Password reset for ${admin.fullName} <${admin.email}>. Log in with the new password now.`);
} catch (err) {
  console.error("FAILED:", err);
  process.exitCode = 1;
} finally {
  await client.end();
}
