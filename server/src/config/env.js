import { config } from "dotenv";
import { fileURLToPath } from "node:url";

// Load before Prisma/email dependencies so development configuration wins over
// their automatic .env loading; explicit process environment still wins.
if (process.env.NODE_ENV !== "production") {
  config({ path: fileURLToPath(new URL("../../.env.local", import.meta.url)) });
}
config({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });
