import { sql } from "@k2b/cloud";
import type { SQL } from "bun";
import { type CodeContext, CodeDataError, codePermission } from "./access";
import type { Code } from "./contracts";

/** Source reads require the resource's editor right, while retaining a read credential ceiling.
 * Cloud administration alone grants only the separate approval source reader.
 */
export async function requireCodeSourcePermission(code: Code, context: CodeContext, db: SQL = sql): Promise<void> {
  if ((await codePermission(code, context, db, "edit")) !== "editor") throw new CodeDataError("NOT_FOUND", "Code not found.");
}
