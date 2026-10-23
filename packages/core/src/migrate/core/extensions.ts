import { type SQL, sql } from "bun";

/** Installation-wide extensions are provisioned by Core before applications start. */
export const migrate = async (db: SQL = sql): Promise<void> => {
  await db`CREATE EXTENSION IF NOT EXISTS pgcrypto`.simple();
};
