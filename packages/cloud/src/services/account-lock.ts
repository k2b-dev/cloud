import type { SQLQuery } from "bun";
import { sql } from "../runtime/clients";

/**
 * True while FreeIPA locks the account (nsaccountlock, mirrored by the sync). No credential of a locked account
 * works: sessions, sign-ins, API keys, OAuth tokens, invocations and mandates all check it. Unlocking in FreeIPA
 * clears it at the next sync. `userId` is an SQL expression for the account's ID.
 */
export const accountLockedSql = (userId: SQLQuery): SQLQuery =>
  sql`EXISTS (SELECT 1 FROM auth.user_ipa_data ipa_lock WHERE ipa_lock.user_id = ${userId} AND ipa_lock.locked_at IS NOT NULL)`;

export const isAccountLocked = async (userId: string, db: typeof sql = sql): Promise<boolean> => {
  const [row] = await db<{ locked: boolean }[]>`SELECT ${accountLockedSql(sql`${userId}::uuid`)} AS locked`;
  return row?.locked === true;
};
