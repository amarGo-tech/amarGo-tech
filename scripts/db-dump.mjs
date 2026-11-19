// Fast full-data backup of the (soon-to-expire) Postgres DB.
// Dumps every base table in the `public` schema to JSON + a plain SQL INSERT file.
// Usage: node scripts/db-dump.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function readEnvDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const p of [path.join(ROOT, "server/.env"), path.join(ROOT, ".env")]) {
    try {
      const txt = fs.readFileSync(p, "utf8");
      const m = txt.match(/^\s*DATABASE_URL\s*=\s*"?([^"\n\r]+)"?/m);
      if (m) return m[1].trim();
    } catch {}
  }
  throw new Error("DATABASE_URL not found in env or .env files");
}

const DATABASE_URL = readEnvDatabaseUrl();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const OUT_DIR = path.join(ROOT, "backups", "db", stamp);
fs.mkdirSync(OUT_DIR, { recursive: true });

// JSON.stringify replacer that keeps data restorable.
function serialize(value) {
  return JSON.stringify(
    value,
    (_k, v) => {
      if (typeof v === "bigint") return { __bigint__: v.toString() };
      if (v && v.type === "Buffer" && Array.isArray(v.data))
        return { __bytea__: Buffer.from(v.data).toString("base64") };
      return v;
    },
    2
  );
}

function sqlLiteral(v, dataType) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "bigint") return v.toString();
  if (Buffer.isBuffer(v)) return `'\\x${v.toString("hex")}'`;
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (Array.isArray(v) || (typeof v === "object")) {
    // json/jsonb/array columns -> store as JSON text
    return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

const { Client } = pg;
const u = new URL(DATABASE_URL);
const client = new Client({
  host: u.hostname,
  port: u.port ? Number(u.port) : 5432,
  user: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password),
  database: u.pathname.replace(/^\//, ""),
  ssl: { rejectUnauthorized: false },
  statement_timeout: 0,
  connectionTimeoutMillis: 30000,
  keepAlive: true,
});

const manifest = {
  createdAt: new Date().toISOString(),
  database: DATABASE_URL.replace(/:\/\/[^@]+@/, "://***:***@"),
  tables: {},
  totalRows: 0,
};

try {
  console.log("Connecting…");
  await client.connect();

  const { rows: tableRows } = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  const tables = tableRows.map((r) => r.table_name);
  console.log(`Found ${tables.length} tables`);

  const sqlParts = [
    "-- DeliverHub DB data dump",
    `-- generated ${new Date().toISOString()}`,
    "-- restore: psql \"$DATABASE_URL\" -f dump.sql  (schema must already exist, e.g. via `prisma db push`)",
    "BEGIN;",
    "SET session_replication_role = replica;  -- skip FK checks during load",
    "",
  ];

  for (const t of tables) {
    const { rows, fields } = await client.query(
      `SELECT * FROM "public"."${t}"`
    );
    const cols = fields.map((f) => f.name);

    // JSON per-table
    fs.writeFileSync(
      path.join(OUT_DIR, `${t}.json`),
      serialize(rows)
    );

    // SQL INSERTs (batched)
    if (rows.length) {
      const colList = cols.map((c) => `"${c}"`).join(", ");
      const BATCH = 500;
      for (let i = 0; i < rows.length; i += BATCH) {
        const slice = rows.slice(i, i + BATCH);
        sqlParts.push(`INSERT INTO "public"."${t}" (${colList}) VALUES`);
        sqlParts.push(
          slice
            .map(
              (row) =>
                "  (" + cols.map((c) => sqlLiteral(row[c])).join(", ") + ")"
            )
            .join(",\n") + ";"
        );
        sqlParts.push("");
      }
    }

    manifest.tables[t] = rows.length;
    manifest.totalRows += rows.length;
    console.log(`  ${t}: ${rows.length} rows`);
  }

  // sequences so IDs continue correctly after restore
  const { rows: seqRows } = await client.query(`
    SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public'
  `);
  for (const s of seqRows) {
    try {
      const { rows: v } = await client.query(
        `SELECT last_value, is_called FROM "public"."${s.sequence_name}"`
      );
      sqlParts.push(
        `SELECT setval('"public"."${s.sequence_name}"', ${v[0].last_value}, ${v[0].is_called});`
      );
    } catch {}
  }

  sqlParts.push("", "SET session_replication_role = origin;", "COMMIT;", "");
  fs.writeFileSync(path.join(OUT_DIR, "dump.sql"), sqlParts.join("\n"));
  fs.writeFileSync(
    path.join(OUT_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2)
  );

  // one combined JSON for convenience
  const combined = {};
  for (const t of tables) {
    combined[t] = JSON.parse(
      fs.readFileSync(path.join(OUT_DIR, `${t}.json`), "utf8")
    );
  }
  fs.writeFileSync(
    path.join(OUT_DIR, "_all.json"),
    JSON.stringify(combined, null, 2)
  );

  console.log(`\nDone. ${manifest.totalRows} rows across ${tables.length} tables.`);
  console.log(`Output: ${OUT_DIR}`);
} catch (err) {
  console.error("BACKUP FAILED:", err);
  process.exitCode = 1;
} finally {
  await client.end();
}
