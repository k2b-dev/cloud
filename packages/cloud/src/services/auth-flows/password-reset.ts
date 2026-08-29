import { redis, sql } from "bun";
import type { User } from "../../contracts/shared";
import { createAuthPasswordResetUrl } from "../../shared/redirect";
import { getFreeIpaConfig } from "../freeipa-config";
import { getServiceIpaSession } from "../ipa/service-account";
import { logger } from "../logging";
import { providers } from "../providers";
import { session } from "../session";
import * as settings from "../settings";
import * as ipaFlow from "./ipa";
import type { AuthNotificationDeliveryResult, AuthNotificationSender } from "./notification-sender";

const log = logger("auth:password-reset");

const REQUEST_TTL_SECONDS = 900;
const REQUEST_COOLDOWN_SECONDS = 60;
const GENERIC_MESSAGE = "If this account can reset a password, a reset link has been sent.";

type ResetTarget = {
  userId: string;
  uid: string;
  email: string;
};

type ResetAttemptSuccess = {
  ok: true;
  userId: string;
  user: User;
};

type ResetAttemptFailure =
  | {
      ok: false;
      status: 400;
      reason: "policy_failed";
      message: string;
    }
  | {
      ok: false;
      status: 400 | 401;
      reason: "invalid_or_expired";
      message: string;
    }
  | {
      ok: false;
      status: number;
      reason: "reset_failed" | "login_failed";
      message: string;
    };

const normalizeEmail = (email: string): string => email.trim().toLowerCase();
const cooldownKey = (email: string) => `password-reset-cooldown:${email}`;

const isInCooldown = async (email: string): Promise<boolean> => {
  if (await redis.get(cooldownKey(email))) return true;
  await redis.set(cooldownKey(email), "1", "EX", REQUEST_COOLDOWN_SECONDS);
  return false;
};

const buildTarget = (row: { id: string; uid: string; mail: string }): ResetTarget => ({
  userId: row.id,
  uid: row.uid,
  email: row.mail,
});

const resolveResetTarget = async (email: string): Promise<ResetTarget | null> => {
  const rows = await sql<{ id: string; uid: string; mail: string }[]>`
    SELECT id, uid, btrim(mail) AS mail
    FROM auth.users
    WHERE provider = 'ipa'
      AND profile = 'user'
      AND lower(btrim(mail)) = ${email}
      AND (account_expires IS NULL OR account_expires > now())
  `;

  if (rows.length !== 1) {
    if (rows.length > 1) {
      log.warn("Password reset skipped: ambiguous IPA email", {
        email,
        matches: rows.length,
      });
    }
    return null;
  }

  return buildTarget(rows[0]!);
};

const resolveResetTargetForToken = async (params: { userId: string; email: string }): Promise<ResetTarget | null> => {
  const rows = await sql<{ id: string; uid: string; mail: string }[]>`
    SELECT id, uid, btrim(mail) AS mail
    FROM auth.users
    WHERE id = ${params.userId}
      AND provider = 'ipa'
      AND profile = 'user'
      AND lower(btrim(mail)) = ${params.email}
      AND (account_expires IS NULL OR account_expires > now())
    LIMIT 1
  `;

  return rows.length === 1 ? buildTarget(rows[0]!) : null;
};

const sendResetEmail = async (
  params: ResetTarget & { redirectTo?: string; locale?: string },
  notificationSender: AuthNotificationSender,
): Promise<AuthNotificationDeliveryResult> => {
  const token = await providers.local.auth.createPasswordResetToken({
    userId: params.userId,
    uid: params.uid,
    email: params.email,
    ttlSeconds: REQUEST_TTL_SECONDS,
  });
  const rawAppUrl = await settings.get<string>("app.url");
  const appUrl = rawAppUrl.startsWith("http") ? rawAppUrl : `https://${rawAppUrl}`;
  const resetLink = createAuthPasswordResetUrl(appUrl, {
    token,
    redirectTo: params.redirectTo,
  });
  return notificationSender.sendPasswordReset({ email: params.email, resetLink, locale: params.locale });
};

const changeTemporaryPassword = async (params: {
  userId: string;
  uid: string;
  email: string;
  temporaryPassword: string;
  newPassword: string;
}): Promise<ResetAttemptSuccess | ResetAttemptFailure> => {
  const changeResult = await ipaFlow.changeExpiredPassword({
    username: params.uid,
    currentPassword: params.temporaryPassword,
    newPassword: params.newPassword,
  });

  if (!changeResult.ok) {
    if (changeResult.reason === "change_failed") {
      return {
        ok: false,
        status: 400,
        reason: "policy_failed",
        message: `${changeResult.message} Request a new reset link and choose a stronger password.`,
      };
    }

    return {
      ok: false,
      status: changeResult.status,
      reason: "login_failed",
      message: changeResult.message,
    };
  }

  await session.revokeAllForUser(changeResult.userId);

  return {
    ok: true,
    userId: changeResult.userId,
    user: changeResult.user,
  };
};

export const request = async (
  params: { email: string; redirectTo?: string; locale?: string },
  notificationSender: AuthNotificationSender,
): Promise<{ ok: true; message: string }> => {
  const email = normalizeEmail(params.email);
  if (await isInCooldown(email)) {
    log.info("Password reset request ignored during cooldown");
    return { ok: true, message: GENERIC_MESSAGE };
  }

  const freeIpaConfig = await getFreeIpaConfig();
  if (!freeIpaConfig.enabled || !freeIpaConfig.configured) {
    log.info("Password reset request accepted while FreeIPA is unavailable");
    return { ok: true, message: GENERIC_MESSAGE };
  }

  const target = await resolveResetTarget(email);
  if (!target) {
    log.info("Password reset request accepted without eligible target");
    return { ok: true, message: GENERIC_MESSAGE };
  }

  try {
    const result = await sendResetEmail({ ...target, redirectTo: params.redirectTo, locale: params.locale }, notificationSender);
    if (result.status === "error") log.error("Password reset delivery failed", { notificationId: result.id, uid: target.uid });
    else log.info("Password reset notification accepted", { notificationId: result.id, uid: target.uid, status: result.status });
  } catch (error) {
    log.error("Password reset notification could not be accepted", {
      uid: target.uid,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { ok: true, message: GENERIC_MESSAGE };
};

export const complete = async (params: { token?: string; newPassword: string }): Promise<ResetAttemptSuccess | ResetAttemptFailure> => {
  if (!params.token) {
    return {
      ok: false,
      status: 400,
      reason: "invalid_or_expired",
      message: "Missing password reset token.",
    };
  }

  const payload = await providers.local.auth.consumePasswordResetToken(params.token);
  if (!payload) {
    return {
      ok: false,
      status: 401,
      reason: "invalid_or_expired",
      message: "This password reset link has expired. Request a new reset link.",
    };
  }

  const target = await resolveResetTargetForToken({
    userId: payload.userId,
    email: payload.email,
  });
  if (!target) {
    return {
      ok: false,
      status: 401,
      reason: "invalid_or_expired",
      message: "This password reset link has expired. Request a new reset link.",
    };
  }

  const serviceSession = await getServiceIpaSession();
  if (!serviceSession.ok) {
    return {
      ok: false,
      status: serviceSession.status,
      reason: "reset_failed",
      message: serviceSession.error,
    };
  }

  const resetResult = await providers.ipa.users.resetPassword({
    ipaSession: serviceSession.data,
    id: target.userId,
  });
  if (!resetResult.ok) {
    return {
      ok: false,
      status: resetResult.status,
      reason: "reset_failed",
      message: resetResult.error,
    };
  }

  return changeTemporaryPassword({
    ...target,
    temporaryPassword: resetResult.data.password,
    newPassword: params.newPassword,
  });
};

export const passwordReset = {
  request,
  complete,
} as const;
