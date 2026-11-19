# Local database

Start the isolated PostgreSQL instance with:

```powershell
docker compose -f docker-compose.local-db.yml up -d --wait
```

The database is available only on `127.0.0.1:5544`. Data persists in the
`amargo-local_amargo-postgres` Docker volume. Other projects' databases are separate.

Set the ignored `server/.env.local` file to:

```dotenv
DATABASE_URL=postgresql://deliverhub:deliverhub-local@127.0.0.1:5544/deliverhub?sslmode=disable
```

In development the server reads this file before `server/.env`.
An explicitly supplied process environment variable takes precedence.
Production does not load `.env.local`.

Historical records come from the local database backup dated 2026-09-03,
not newly generated seed data. The snapshot may itself contain historical demo records.
Restoration was verified against the backup manifest: 55 tables, 16,200 rows,
including 61 stores, 3,529 products and 89 orders. The marketplace API returned
HTTP 200 using this database. Browsing stores no longer creates or rewrites a demo store.
Database passwords, sessions, account status and subscription dates retain their backed-up values.
The local database does not make historical subscriptions current or renew external payment/email credentials.

Use `docker compose -f docker-compose.local-db.yml stop` to stop PostgreSQL while
preserving records. Do not remove the volume unless intentionally discarding the local data.
