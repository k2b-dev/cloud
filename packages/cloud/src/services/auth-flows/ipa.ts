import { sql } from "bun";
import type { User } from "../../contracts/shared";
import { isAccountCategoryAllowed } from "../account-category-policy";
import { accounts } from "../accounts";
import { logger } from "../logging";
import { providers } from "../providers";

type IpaLoginFailure =
  | { ok: false; status: 403; reason: "category_disabled"; message: string }
  | { ok: false; status: 401; reason: "password_expired"; message: string; uid: string }
  | { ok: false; status: 401; reason: "invalid_credentials"; message: string }
  | { ok: false; status: 400; reason: "user_not_synced"; message: string }
  | { ok: false; status: 400; reason: "user_not_found"; message: string }
  | { ok: false; status: 403; reason: "account_expired"; message: string }
  | { ok: false; status: 403; reason: "account_out_of_scope"; message: string }
  | { ok: false; status: 503; reason: "sync_unavailable"; message: string };

type IpaLoginSuccess = {
  ok: true;
  userId: string;
  user: User;
};

export type IpaLoginFlowResult = IpaLoginSuccess | IpaLoginFailure;

const log = logger("auth:ipa");
const DUMMY_LOGIN_UID = "__cloud_invalid_ipa_email_login__";

const normalizeEmail = (value: string): string => value.trim().toLowerCase();

const resolveIpaLoginUid = async (identifier: string): Promise<string | null> => {
  const trimmed = identifier.trim();
  if (!trimmed) return null;
  if (!trimmed.includes("@")) return trimmed;

  const rows = await sql<{ uid: string }[]>`
    SELECT uid
    FROM auth.users
    WHERE provider = 'ipa'
      AND lower(btrim(mail)) = ${normalizeEmail(trimmed)}
  `;

  if (rows.length !== 1) {
    if (rows.length > 1) {
      log.warn("FreeIPA email login skipped: ambiguous email", {
        email: normalizeEmail(trimmed),
        matches: rows.length,
      });
    }
    return null;
  }
  return rows[0]!.uid;
};

const failInvalidCredentials = async (params: { identifier: string; password: string }): Promise<IpaLoginFailure> => {
  if (params.identifier.trim().includes("@")) {
    await providers.ipa.auth.login(DUMMY_LOGIN_UID, params.password).catch(() => undefined);
  }
  return { ok: false, status: 401, reason: "invalid_credentials", message: "Invalid username or password" };
};

const loadSyncedIpaUser = async (uid: string): Promise<{ ok: true; userId: string; user: User } | IpaLoginFailure> => {
  const userRows = await sql`
    SELECT id FROM auth.users
    WHERE provider = 'ipa'
      AND uid = ${uid}
  `;
  if (userRows.length === 0) {
    return {
      ok: false,
      status: 400,
      reason: "user_not_synced",
      message: "Your account is not yet available. Please try again in a few minutes.",
    };
  }

  const userId = userRows[0]!.id as string;
  const user = await accounts.users.get({ id: userId });
  if (!user) {
    return {
      ok: false,
      status: 400,
      reason: "user_not_found",
      message: "User not found. Please try again.",
    };
  }

  return { ok: true, userId, user };
};

export const login = async (params: { username: string; password: string }): Promise<IpaLoginFlowResult> => {
  if (!(await isAccountCategoryAllowed({ provider: "ipa", profile: "user" })))
    return { ok: false, status: 403, reason: "category_disabled", message: "FreeIPA accounts are disabled. Contact an administrator." };
  const uid = await resolveIpaLoginUid(params.username);
  if (!uid) {
    return failInvalidCredentials({ identifier: params.username, password: params.password });
  }

  const loginResult = await providers.ipa.auth.login(uid, params.password).catch((error) => {
    log.error("FreeIPA login transport failed", {
      uid,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
  if (!loginResult) {
    return {
      ok: false,
      status: 503,
      reason: "sync_unavailable",
      message: "Could not reach FreeIPA. Please try again.",
    };
  }
  if (loginResult.status === "password_expired") {
    return { ok: false, status: 401, reason: "password_expired", message: "Password expired", uid };
  }
  if (loginResult.status !== "success") {
    return { ok: false, status: 401, reason: "invalid_credentials", message: "Invalid username or password" };
  }

  // Must reach a "synced" outcome before granting a session. Stale mirror rows
  // (expired remotely, dropped from sync scope, or fetch failures) must never
  // grant a fresh local session on the back of successful FreeIPA credentials.
  const syncOutcome = await providers.ipa.sync.user(uid).catch((error) => {
    log.error("FreeIPA login verification failed", {
      uid,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      status: "fetch_failed" as const,
      error: error instanceof Error ? error.message : String(error),
    };
  });
  switch (syncOutcome.status) {
    case "synced":
      break;
    case "skipped_disabled":
      break;
    case "expired":
      return {
        ok: false,
        status: 403,
        reason: "account_expired",
        message: "Your FreeIPA account is expired. Contact an administrator.",
      };
    case "out_of_scope":
      return {
        ok: false,
        status: 403,
        reason: "account_out_of_scope",
        message: "Your FreeIPA account is no longer part of the sync scope. Contact an administrator.",
      };
    case "not_found_local":
      return {
        ok: false,
        status: 400,
        reason: "user_not_synced",
        message: "Your account is not yet available. Please try again in a few minutes.",
      };
    case "fetch_failed":
      return {
        ok: false,
        status: 503,
        reason: "sync_unavailable",
        message: "Could not verify your account with FreeIPA. Please try again.",
      };
  }

  const userResult = await loadSyncedIpaUser(uid);
  if (!userResult.ok) return userResult;

  return {
    ok: true,
    userId: userResult.userId,
    user: userResult.user,
  };
};

export const changeExpiredPassword = async (params: {
  username: string;
  currentPassword: string;
  newPassword: string;
}): Promise<IpaLoginFlowResult | { ok: false; status: number; reason: "change_failed"; message: string }> => {
  if (!(await isAccountCategoryAllowed({ provider: "ipa", profile: "user" })))
    return { ok: false, status: 403, reason: "category_disabled", message: "FreeIPA accounts are disabled. Contact an administrator." };
  const changeResult = await providers.ipa.auth.changeExpiredPassword(params);
  if (!changeResult.ok) {
    return {
      ok: false,
      status: changeResult.status,
      reason: "change_failed",
      message: changeResult.error,
    };
  }

  return login({ username: params.username, password: params.newPassword });
};
