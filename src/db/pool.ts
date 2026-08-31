import { Pool } from "pg";
import { env } from "../config/env";

export const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: env.databaseSsl ? { rejectUnauthorized: false } : undefined,
});

pool.on("error", (err) => {
  // Idle client errors shouldn't crash the whole process
  console.error("[pg pool] unexpected error on idle client", err);
});
