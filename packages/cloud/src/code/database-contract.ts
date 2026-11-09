import { z } from "zod";
import { CAPABILITY_MAX_RESULT_BYTES } from "../contracts/capability-limits";

/** Same bounded JSON bridge as application calls; a statement also has Studio's 15-second ceiling. */
export const CODE_DATABASE_LIMITS = Object.freeze({ resultBytes: CAPABILITY_MAX_RESULT_BYTES, statementMs: 15_000 });
const statement = z
  .object({
    sql: z.string().min(1).max(CAPABILITY_MAX_RESULT_BYTES),
    params: z.array(z.union([z.string(), z.number().finite(), z.boolean(), z.null()])).default([]),
  })
  .strict();
export const CodeDatabaseRequestSchema = z.discriminatedUnion("operation", [
  statement.extend({ operation: z.literal("db.query") }),
  statement.extend({ operation: z.literal("db.exec") }),
  z.object({ operation: z.literal("db.batch"), statements: z.array(statement).min(1) }).strict(),
]);
export type CodeDatabaseRequest = z.infer<typeof CodeDatabaseRequestSchema>;

export const CODE_DATABASE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  code_db_unavailable: "The Code database service is unavailable. Ask an administrator to configure RSQL in Core settings.",
  code_db_busy: "A Code database is being initialized or deleted. Try again shortly.",
  code_db_full: "This Code has reached its database storage limit. Remove data or ask an administrator to raise the limit.",
  code_db_undeclared: "This version has no checked database evidence. Import db from @sdk and check and submit the Code again.",
  code_db_invalid: "Use a database statement with bound scalar parameters, or a nonempty atomic batch.",
  code_db_limit: "The database result exceeds the bridge size limit. Select fewer rows or columns.",
  code_db_timeout: "The database call exceeded its time limit. A write may already have committed; check its outcome before retrying.",
  code_db_sql: "The database statement failed. Check the SQL and its bound parameters.",
});
