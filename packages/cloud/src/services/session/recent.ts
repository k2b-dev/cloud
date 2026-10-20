import type { SQL } from "bun";
import { isAccountCategoryAllowed } from "../account-category-policy";

export type EligibleAccount = {
  id: string;
  uid: string;
  display_name: string | null;
  provider: "local" | "ipa";
  profile: "guest" | "user";
  auth_epoch: string;
  account_expires: Date | null;
};

/** New personal access requires a browser sign-in from the last ten minutes. */
export const LASTING_ACCESS_SIGN_IN_SECONDS = 600;

export class ConfirmedBrowserSignInError extends Error {
  constructor(readonly code: "REAUTHENTICATE" | "FORBIDDEN") {
    super(code === "REAUTHENTICATE" ? "Sign in again to confirm it is you." : "This account cannot create new access.");
  }
}

type Reject = (code: "REAUTHENTICATE" | "FORBIDDEN") => never;

/** The account exists, has not expired and its category is enabled. */
export const requireEligibleAccount = async (tx: SQL, userId: string, reject: Reject): Promise<EligibleAccount> => {
  const [row] = await tx<EligibleAccount[]>`
    SELECT id, uid, display_name, provider, profile, auth_epoch, account_expires FROM auth.users WHERE id = ${userId}::uuid
  `;
  if (!row || (row.account_expires && new Date(row.account_expires).getTime() <= Date.now()) || !(await isAccountCategoryAllowed(row, tx)))
    return reject("FORBIDDEN");
  return row;
};

/**
 * The web session family `sid` is valid and was issued within `seconds`. App sessions of the
 * mobile app never count: they are renewed daily without a sign-in.
 */
export const requireRecentWebSession = async (
  tx: SQL,
  actor: { userId: string; sid: string },
  seconds: number,
  reject: Reject,
): Promise<EligibleAccount> => {
  const [row] = await tx`SELECT sid FROM auth.session_families f JOIN auth.users u ON u.id = f.user_id
    WHERE f.sid = ${actor.sid}::uuid AND f.user_id = ${actor.userId}::uuid AND f.revoked_at IS NULL
      AND f.auth_epoch = u.auth_epoch AND f.expires_at > now() AND f.pwa_device_id IS NULL
      AND f.issued_at > now() - ${seconds} * interval '1 second'`;
  if (!row) return reject("REAUTHENTICATE");
  return requireEligibleAccount(tx, actor.userId, reject);
};

/** Checks the browser session inside the transaction that creates personal access. */
export const requireConfirmedBrowserSignIn = (tx: SQL, signIn: { userId: string; sid: string }, reject: Reject): Promise<EligibleAccount> =>
  requireRecentWebSession(tx, signIn, LASTING_ACCESS_SIGN_IN_SECONDS, reject);
