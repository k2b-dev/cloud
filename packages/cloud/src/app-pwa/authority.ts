import type { SQL, TransactionSQL } from "bun";
import { accountCategory } from "../contracts/account-categories";
import { decodeAccountCategoryEnabled } from "../services/account-category-policy";
import { type AppPwaWebSignIn, pwaFail } from "./contracts";

type User = {
  auth_epoch: string;
  provider: "local" | "ipa";
  profile: "guest" | "user";
  account_expires: Date | null;
};
type Family = {
  auth_epoch: string;
  expires_at: Date;
  revoked_at: Date | null;
  pwa_device_id: string | null;
  signing_kid: string;
  legal_pending: boolean;
};

export const databaseClock = async (tx: TransactionSQL): Promise<Date> => {
  const [row] = await tx<{ time: Date }[]>`SELECT clock_timestamp() AS time`;
  if (!row) return pwaFail("UNAVAILABLE", 503);
  return row.time;
};

/** Supported on PostgreSQL 15–17. Keep the query cancellable through execution. */
export const boundTransaction = (tx: SQL, remainingMilliseconds: number) => {
  if (!Number.isSafeInteger(remainingMilliseconds) || remainingMilliseconds < 1) return pwaFail("UNAVAILABLE", 503);
  const timeout = `${remainingMilliseconds}ms`;
  return tx`SELECT set_config('statement_timeout', ${timeout}, true), set_config('lock_timeout', ${timeout}, true),
    set_config('idle_in_transaction_session_timeout', ${timeout}, true)`;
};

/**
 * Core order: user -> session family -> signing key. All locks survive domain writes and commit.
 * Logout updates this family; epoch invalidation/deactivation updates this user; key revoke updates this key.
 * Never replace this with a cached authentication callback or a preflight HTTP request.
 */
export const lockWebAuthority = async (tx: TransactionSQL, signIn: AppPwaWebSignIn) => {
  const [user] = await tx<User[]>`SELECT auth_epoch, provider, profile, account_expires
    FROM auth.users WHERE id = ${signIn.userId}::uuid FOR NO KEY UPDATE`;
  if (!user) return pwaFail("WEB_SESSION_REQUIRED", 401);
  const [family] = await tx<Family[]>`SELECT auth_epoch, expires_at, revoked_at, pwa_device_id, signing_kid, legal_pending
    FROM auth.session_families WHERE sid = ${signIn.sid}::uuid AND user_id = ${signIn.userId}::uuid FOR UPDATE`;
  if (!family) return pwaFail("WEB_SESSION_REQUIRED", 401);
  const [key] = await tx<{ state: string }[]>`SELECT state FROM auth.signing_keys
    WHERE kid = ${family.signing_kid} FOR SHARE`;
  const categoryKey = `user.category.${accountCategory(user)}.enabled`;
  // A row lock cannot serialize an absent default with the first policy INSERT.
  // Settings has no shared category writer lock; ordinary DML conflicts with SHARE.
  await tx`LOCK TABLE settings.entries IN SHARE MODE`;
  const [category] = await tx<{ value: string }[]>`SELECT value FROM settings.entries WHERE key = ${categoryKey} FOR SHARE`;
  const legal =
    !family.legal_pending || (await tx`SELECT 1 FROM auth.legal_acceptances WHERE user_id = ${signIn.userId}::uuid LIMIT 1`).length > 0;
  const categoryEnabled = await decodeAccountCategoryEnabled(category?.value);
  const check = (time: Date) => {
    if (
      family.revoked_at ||
      family.pwa_device_id ||
      !key ||
      key.state === "revoked" ||
      String(family.auth_epoch) !== String(user.auth_epoch) ||
      family.expires_at <= time ||
      !legal ||
      (user.account_expires && user.account_expires <= time) ||
      !categoryEnabled
    ) {
      return pwaFail("WEB_SESSION_REQUIRED", 401);
    }
    return new Date(Math.min(family.expires_at.getTime(), user.account_expires?.getTime() ?? Infinity));
  };
  await check(await databaseClock(tx));
  return { user, family, check };
};
