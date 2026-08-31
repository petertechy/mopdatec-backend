import fs from "fs";
import path from "path";
import { pool } from "./pool";

export async function run() {
  const schemaPath = path.resolve(__dirname, "../../database/schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  console.log("[migrate] applying database/schema.sql ...");
  await pool.query(sql);
  console.log("[migrate] done.");
  await pool.end();
}

if (require.main === module) {
  run().catch((err) => {
    console.error("[migrate] failed:", err);
    process.exit(1);
  });
}
