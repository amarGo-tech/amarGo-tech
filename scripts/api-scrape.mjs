// Fallback backup: pull whatever the LIVE Render API still exposes, without DB access.
// The only unauthenticated data source is GET /api/customer/stores (store + product catalog).
// Everything else (users, orders, couriers, payments, wallets, deliveries…) needs
// credentials we don't have, so it cannot be recovered this way.
// Usage: node scripts/api-scrape.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BASE = process.env.API_BASE || "https://deliverhub-gateway.onrender.com";

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const OUT_DIR = path.join(ROOT, "backups", "api", stamp);
fs.mkdirSync(OUT_DIR, { recursive: true });

async function getJson(url, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    } catch (err) {
      if (i === tries) throw err;
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

const manifest = { createdAt: new Date().toISOString(), base: BASE, sources: {} };

try {
  // ---- health / topology snapshot ----
  try {
    const health = await getJson(`${BASE}/api/health`);
    fs.writeFileSync(path.join(OUT_DIR, "health.json"), JSON.stringify(health, null, 2));
    manifest.sources.health = "ok";
  } catch (e) {
    manifest.sources.health = String(e.message);
  }

  // ---- store + product catalog (paginated) ----
  const pageSize = 50;
  let page = 1;
  let totalPages = 1;
  const rawPages = [];
  const stores = [];
  do {
    const data = await getJson(
      `${BASE}/api/customer/stores?page=${page}&pageSize=${pageSize}`
    );
    rawPages.push(data);
    for (const s of data.items || []) stores.push(s);
    totalPages = data.totalPages || 1;
    console.log(`stores page ${page}/${totalPages} -> ${data.items?.length ?? 0} stores`);
    page++;
  } while (page <= totalPages);

  // de-dupe by id (ensureDemoStore + pagination can overlap)
  const byId = new Map();
  for (const s of stores) byId.set(s.id, s);
  const uniqueStores = [...byId.values()];

  const products = [];
  for (const s of uniqueStores) {
    for (const p of s.products || []) {
      products.push({ storeId: s.id, storeName: s.name, storeSlug: s.slug, ...p });
    }
  }

  fs.writeFileSync(
    path.join(OUT_DIR, "stores.raw-pages.json"),
    JSON.stringify(rawPages, null, 2)
  );
  fs.writeFileSync(
    path.join(OUT_DIR, "stores.json"),
    JSON.stringify(uniqueStores, null, 2)
  );
  fs.writeFileSync(
    path.join(OUT_DIR, "products.json"),
    JSON.stringify(products, null, 2)
  );

  // flat CSV for products (easy to eyeball / import)
  const csvRows = [
    "storeSlug,storeName,productId,productName,category,priceMnt,weightGrams,imageUrl",
    ...products.map((p) =>
      [
        p.storeSlug,
        p.storeName,
        p.id,
        p.name,
        p.category,
        p.priceMnt,
        p.weightGrams,
        p.imageUrl,
      ]
        .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
        .join(",")
    ),
  ];
  fs.writeFileSync(path.join(OUT_DIR, "products.csv"), csvRows.join("\n"));

  manifest.sources.stores = {
    endpoint: "GET /api/customer/stores",
    stores: uniqueStores.length,
    products: products.length,
  };

  manifest.notRecoverable = [
    "users / tenant members / roles / sessions",
    "customers / addresses / carts",
    "orders / order items / status history",
    "couriers / delivery employees / assignments / tracking / location points",
    "payments / invoices / transactions / refunds / ledger / wallets / payouts / bank accounts",
    "inventory items / movements / warehouses / branches (full) / delivery zones / pricing rules",
    "notifications / disputes / attachments / audit logs / risk events",
    "identity & face verification sessions / biometric consent / subscriptions",
  ];

  fs.writeFileSync(
    path.join(OUT_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2)
  );

  console.log(
    `\nDone. ${uniqueStores.length} stores, ${products.length} products.`
  );
  console.log(`Output: ${OUT_DIR}`);
  console.log(
    "\nNOTE: only the public catalog was reachable. A full backup still needs\n" +
      "direct DB access (Render Access Control allowlist) or a dump run from inside Render."
  );
} catch (err) {
  console.error("SCRAPE FAILED:", err);
  process.exitCode = 1;
}
