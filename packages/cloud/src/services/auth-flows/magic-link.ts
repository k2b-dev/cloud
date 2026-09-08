import { redis, sql } from "bun";
import { accountCategory } from "../../contracts/account-categories";
import type { User } from "../../contracts/shared";
import { createAuthLoginUrl } from "../../shared/redirect";
import { isAccountCategoryAllowed } from "../account-category-policy";
import { accounts } from "../accounts";
import { logger } from "../logging";
import { providers } from "../providers";
import * as settings from "../settings";
import type { AuthNotificationSender } from "./notification-sender";

const log = logger("auth:magic-link");
const IPA_HINT_COOLDOWN_SECONDS = 300;

const normalizeEmail = (email: string): string => email.trim().toLowerCase();
const ipaHintCooldownKey = (email: string): string => `ipa-email-login-hint-cooldown:${email}`;

const getAppUrl = async (): Promise<string> => {
  const rawAppUrl = await settings.get<string>("app.url");
  return rawAppUrl.startsWith("http") ? rawAppUrl : `https://${rawAppUrl}`;
};

const hasIpaAccountForEmail = async (email: string): Promise<boolean> => {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM auth.users
      WHERE provider = 'ipa'
        AND lower(btrim(mail)) = ${email}
    ) AS exists
  `;
  return Boolean(rows[0]?.exists);
};

const claimIpaHintCooldown = async (email: string): Promise<boolean> => {
  const result = await redis.send("SET", [ipaHintCooldownKey(email), "1", "EX", String(IPA_HINT_COOLDOWN_SECONDS), "NX"]);
  return result === "OK";
};

const sendIpaEmailLoginHint = async (
  params: { email: string; redirectTo?: string; locale?: string },
  notificationSender: AuthNotificationSender,
): Promise<void> => {
  const appUrl = await getAppUrl();
  const loginUrl = createAuthLoginUrl(appUrl, {
    method: "ipa",
    redirectTo: params.redirectTo,
  });
  const result = await notificationSender.sendIpaLoginHint({ email: params.email, loginUrl, locale: params.locale });
  if (result.status === "error") log.error("FreeIPA login hint delivery failed", { notificationId: result.id });
};

export const request = async (
  params: { email: string; redirectTo?: string; locale?: string; category?: "guest" | "login" },
  notificationSender: AuthNotificationSender,
): Promise<{ ok: true } | { ok: false; status: 400; message: string }> => {
  const email = normalizeEmail(params.email);
  const hasIpaUser = await hasIpaAccountForEmail(email);
  const userRows = hasIpaUser
    ? []
    : await sql<
        { provider: "local" | "ipa"; profile: "guest" | "user" }[]
      >`SELECT provider, profile FROM auth.users WHERE lower(btrim(mail)) = ${email}`;
  const localUser = userRows.find((row) => row.provider === "local");
  const allowSelfRegistration = await settings.get<boolean>("user.allow_self_registration");

  if (hasIpaUser) {
    if (!(await isAccountCategoryAllowed({ provider: "ipa", profile: "user" }))) return { ok: true };
    if (await claimIpaHintCooldown(email)) {
      void sendIpaEmailLoginHint({ email, redirectTo: params.redirectTo, locale: params.locale }, notificationSender).catch((error) => {
        log.warn("Failed to send FreeIPA email-login hint", {
          email,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return { ok: true };
  }

  if (localUser && ((params.category && accountCategory(localUser) !== params.category) || !(await isAccountCategoryAllowed(localUser))))
    return { ok: true };
  if (
    !localUser &&
    (!allowSelfRegistration || params.category === "login" || !(await isAccountCategoryAllowed({ provider: "local", profile: "guest" })))
  ) {
    return { ok: true };
  }

  const token = await providers.local.auth.createMagicLinkToken({ email, category: params.category, ttlSeconds: 300 });
  const appUrl = await getAppUrl();
  const magicLink = createAuthLoginUrl(appUrl, { token, redirectTo: params.redirectTo });

  try {
    const result = await notificationSender.sendMagicLink({ email, token, magicLink, locale: params.locale });
    if (result.status === "error") log.error("Magic link delivery failed", { notificationId: result.id });
  } catch (error) {
    // Keep the response generic to prevent account enumeration. The durable
    // sender records accepted delivery failures; pre-persistence failures land here.
    log.error("Magic link notification could not be accepted", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return { ok: true };
};

export const verify = async (params: {
  token: string;
}): Promise<
  | { ok: true; userId: string; user: User; email: string; createdGuest: boolean }
  | { ok: false; status: 401; message: string }
  | { ok: false; status: number; message: string }
> => {
  const payload = await providers.local.auth.consumeMagicLinkToken(params.token);
  if (!payload) {
    return { ok: false, status: 401, message: "Invalid or expired token" };
  }

  const { email, category } = payload;
  const normalizedEmail = normalizeEmail(email);
  if (await hasIpaAccountForEmail(normalizedEmail)) {
    return {
      ok: false,
      status: 401,
      message: "This email address belongs to a FreeIPA-managed account. Sign in with FreeIPA.",
    };
  }

  // Reject expired accounts at login time, not just during cleanup. Without
  // this, an expired local user / guest could still authenticate in the
  // window between expiry and the next lifecycle run.
  const userRows = await sql`
    SELECT id, account_expires
    FROM auth.users
    WHERE lower(btrim(mail)) = ${normalizedEmail} AND provider = 'local'
      AND (account_expires IS NULL OR account_expires > now())
    ORDER BY profile = 'user' DESC
    LIMIT 1
  `;

  let userId: string;
  let createdGuest = false;
  if (userRows.length > 0) {
    userId = userRows[0]!.id as string;
  } else {
    // Distinguish "no account" from "account expired" for a better error.
    const expiredRows = await sql`
      SELECT id
      FROM auth.users
      WHERE lower(btrim(mail)) = ${normalizedEmail} AND provider = 'local'
        AND account_expires IS NOT NULL AND account_expires <= now()
      LIMIT 1
    `;
    if (expiredRows.length > 0) {
      return {
        ok: false,
        status: 403,
        message: "Your account has expired. Contact an administrator.",
      };
    }
    const allowSelfRegistration = await settings.get<boolean>("user.allow_self_registration");
    if (!allowSelfRegistration || category === "login" || !(await isAccountCategoryAllowed({ provider: "local", profile: "guest" }))) {
      return {
        ok: false,
        status: 401,
        message: "Only existing local accounts can sign in with email. Contact an administrator if you need access.",
      };
    }
    const guest = await providers.local.users.createGuest({ email });
    if (!guest.ok) {
      return { ok: false, status: guest.status, message: guest.error };
    }
    userId = guest.data.id;
    createdGuest = true;
  }

  const user = await accounts.users.get({ id: userId });
  if (!user) {
    return { ok: false, status: 401, message: "User not found" };
  }
  if (!(await isAccountCategoryAllowed(user)) || (category && accountCategory(user) !== category))
    return { ok: false, status: 403, message: "This account cannot sign in through this category. Contact an administrator." };

  return { ok: true, userId, user, email, createdGuest };
};
