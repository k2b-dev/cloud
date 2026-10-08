import { sql } from "bun";

/** Idempotent, additive start-up migration. Each later slice adds its tables here with `IF NOT EXISTS`. */
export const migrate = async (): Promise<void> => {
  await sql`CREATE SCHEMA IF NOT EXISTS chat`.simple();
  console.log("  ✓ chat schema");
};
