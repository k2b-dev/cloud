import type { SQL } from "bun";
/** All Core replicas take this short database admission lock; no network work runs while holding it. */
export const codeAdmissionLock = async (db: SQL) => {
  await db`SELECT set_config('statement_timeout','5000',true)`;
  await db`SELECT pg_advisory_xact_lock(hashtextextended('core.code.dispatch',0))`;
};
