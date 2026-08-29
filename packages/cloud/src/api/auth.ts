import { sql } from "bun";
import { type Context, Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { env } from "../config";
import { ChangeExpiredPasswordSchema } from "../contracts";
import { type AuthContext, auth, getLocale, jsonResponse, rateLimit, respond, v } from "../server";
import { accounts, authFlows, getFreeIpaConfig, logger, webauthn } from "../services";
import type { AuthNotificationSender } from "../services/auth-flows/notification-sender";

const log = logger("auth");

import { ErrorResponseSchema, MessageResponseSchema } from "../contracts";
import {
  AdminLoginSchema,
  AuthResponseSchema,
  EmailLoginSchema,
  LoginSchema,
  PasswordResetCompleteSchema,
  PasswordResetRequestSchema,
  VerifyPasskeyAuthenticationSchema,
  VerifyTokenSchema,
} from "./auth/schemas";

const jsonError = (c: Context, message: string, status: 400 | 401 | 500 | 503) => c.json({ message }, status);

/** Authentication routes: login, logout. */
export const createAuthRoutes = (notificationSender: AuthNotificationSender) =>
  new Hono<AuthContext>()
    .use(rateLimit())
    .post(
      "/login",
      describeRoute({
        tags: ["Auth"],
        summary: "Login via FreeIPA",
        description: "Authenticate with FreeIPA username and password. Returns a session token and sets a session cookie.",
        responses: {
          200: jsonResponse(AuthResponseSchema, "Login successful"),
          401: jsonResponse(ErrorResponseSchema, "Invalid username or password"),
          503: jsonResponse(ErrorResponseSchema, "FreeIPA unavailable"),
        },
      }),
      v("json", LoginSchema),
      async (c) => {
        const { username, password, acceptedAgb: _ } = c.req.valid("json");
        if (!(await getFreeIpaConfig()).enabled) {
          return c.json({ message: "FreeIPA is disabled." }, 400);
        }

        const loginResult = await authFlows.ipa.login({ username, password });
        if (!loginResult.ok && loginResult.reason === "password_expired") {
          log.info("Login failed", { uid: loginResult.uid, reason: "password_expired" });
          return c.json({ message: "Password expired", passwordExpired: true, ipaUid: loginResult.uid }, 401);
        }
        if (!loginResult.ok) {
          log.info("Login failed", {
            uid: username,
            reason: loginResult.reason,
          });
          return c.json({ message: loginResult.message }, loginResult.status);
        }

        // Store minimal session in Redis
        const sessionToken = await auth.session.create(c, loginResult.userId);

        log.info("Login successful", { uid: loginResult.user.uid });
        return c.json({
          session_token: sessionToken,
          user: loginResult.user,
        });
      },
    )
    .post(
      "/passkeys/authentication/start",
      describeRoute({
        tags: ["Auth"],
        summary: "Start passkey login",
        description: "Create WebAuthn authentication options for passkey sign-in.",
        responses: {
          200: jsonResponse(z.unknown(), "Passkey authentication options"),
          400: jsonResponse(ErrorResponseSchema, "Passkey login is not available"),
        },
      }),
      async (c) => respond(c, webauthn.beginAuthentication()),
    )
    .post(
      "/passkeys/authentication/verify",
      describeRoute({
        tags: ["Auth"],
        summary: "Verify passkey login",
        description: "Verify a WebAuthn authentication response and create a normal Cloud session.",
        responses: {
          200: jsonResponse(AuthResponseSchema, "Passkey login successful"),
          401: jsonResponse(ErrorResponseSchema, "Passkey verification failed"),
        },
      }),
      v("json", VerifyPasskeyAuthenticationSchema),
      async (c) => {
        const result = await webauthn.finishAuthentication({
          response: c.req.valid("json").response as never,
        });
        if (!result.ok) {
          const status = result.error.status;
          return c.json({ message: result.error.message, code: result.error.code }, status as 400 | 401 | 403 | 404 | 409 | 500);
        }

        const sessionToken = await auth.session.create(c, result.data.user.id);
        log.info("Passkey login successful", { uid: result.data.user.uid });
        return c.json({ session_token: sessionToken, user: result.data.user });
      },
    )
    .post(
      "/logout",
      describeRoute({
        tags: ["Auth"],
        summary: "Logout",
        description:
          "Idempotent: clears the session cookie and deletes the session key if present. No authentication required — logout must always succeed.",
        responses: {
          200: jsonResponse(MessageResponseSchema, "Session invalidated"),
        },
      }),
      async (c) => {
        await auth.session.delete(c);
        log.info("Logout");
        return c.json({ message: "Logged out" });
      },
    )
    .post(
      "/change-expired-password",
      describeRoute({
        tags: ["Auth"],
        summary: "Change expired password",
        description:
          "Change an expired or temporary password using FreeIPA's change_password endpoint. No active session required. For regular password changes of a logged-in user, use POST /api/me/password instead.",
        responses: {
          200: jsonResponse(AuthResponseSchema, "Password changed and logged in"),
          400: jsonResponse(ErrorResponseSchema, "Failed to change password"),
          503: jsonResponse(ErrorResponseSchema, "FreeIPA unavailable"),
        },
      }),
      v("json", ChangeExpiredPasswordSchema),
      async (c) => {
        const { username, currentPassword, newPassword } = c.req.valid("json");
        if (!(await getFreeIpaConfig()).enabled) {
          return c.json({ message: "FreeIPA is disabled." }, 400);
        }

        const changeResult = await authFlows.ipa.changeExpiredPassword({
          username,
          currentPassword,
          newPassword,
        });
        if (!changeResult.ok) {
          if (changeResult.reason === "change_failed") {
            const status = changeResult.status === 503 ? 503 : changeResult.status >= 500 ? 500 : 400;
            return jsonError(c, changeResult.message, status);
          }
          if (changeResult.reason === "password_expired") {
            return c.json({ message: "Password expired", passwordExpired: true }, 401);
          }
          return jsonError(c, changeResult.message, changeResult.status === 401 ? 401 : 400);
        }

        const sessionToken = await auth.session.create(c, changeResult.userId);

        log.info("Password changed via expired flow", { uid: username });
        return c.json({ session_token: sessionToken, user: changeResult.user });
      },
    )
    .post(
      "/email-login",
      describeRoute({
        tags: ["Auth"],
        summary: "Request magic link login",
        description: "Request a magic link token via email for local account sign-in.",
        responses: {
          200: jsonResponse(MessageResponseSchema, "Request accepted"),
          400: jsonResponse(ErrorResponseSchema, "Email sign-in not available"),
        },
      }),
      v("json", EmailLoginSchema),
      async (c) => {
        const { email, redirectTo } = c.req.valid("json");

        const requestResult = await authFlows.magicLink.request({ email, redirectTo, locale: getLocale(c) }, notificationSender);
        if (!requestResult.ok) {
          return c.json({ message: requestResult.message }, requestResult.status);
        }

        log.info("Magic link requested", { email });
        return c.json({
          message: "If this email can sign in with a login code, a code has been sent.",
        });
      },
    )
    .post(
      "/verify-token",
      describeRoute({
        tags: ["Auth"],
        summary: "Verify magic link token",
        description: "Verify a magic link token and create a session.",
        responses: {
          200: jsonResponse(AuthResponseSchema, "Token verified, session created"),
          401: jsonResponse(ErrorResponseSchema, "Invalid or expired token"),
        },
      }),
      v("json", VerifyTokenSchema),
      async (c) => {
        const { token } = c.req.valid("json");

        const verifyResult = await authFlows.magicLink.verify({ token });
        if (!verifyResult.ok) {
          log.info("Token invalid/expired");
          const status = verifyResult.status >= 500 ? 500 : verifyResult.status === 400 ? 400 : 401;
          return jsonError(c, verifyResult.message, status);
        }

        // Create session (no IPA session for email-only users)
        const sessionToken = await auth.session.create(c, verifyResult.userId);

        if (verifyResult.createdGuest) {
          log.info("Guest user created", {
            email: verifyResult.email,
            uid: verifyResult.user.uid,
          });
        }
        log.info("Token verified", { email: verifyResult.email });
        return c.json({ session_token: sessionToken, user: verifyResult.user });
      },
    )
    .post(
      "/password-reset/request",
      describeRoute({
        tags: ["Auth"],
        summary: "Request password reset",
        description:
          "Request a one-time password reset email for an IPA-backed account. The response is always generic to avoid account enumeration.",
        responses: {
          200: jsonResponse(MessageResponseSchema, "Request accepted"),
        },
      }),
      v("json", PasswordResetRequestSchema),
      async (c) => {
        const { email, redirectTo } = c.req.valid("json");

        const result = await authFlows.passwordReset.request({ email, redirectTo, locale: getLocale(c) }, notificationSender);
        return c.json({ message: result.message });
      },
    )
    .post(
      "/password-reset/complete",
      describeRoute({
        tags: ["Auth"],
        summary: "Complete password reset",
        description:
          "Set a new password using a one-time reset token. Creates a normal Cloud session only after the password was changed successfully.",
        responses: {
          200: jsonResponse(AuthResponseSchema, "Password reset completed and session created"),
          400: jsonResponse(ErrorResponseSchema, "Password reset failed"),
          401: jsonResponse(ErrorResponseSchema, "Invalid or expired reset token"),
        },
      }),
      v("json", PasswordResetCompleteSchema),
      async (c) => {
        const { token, newPassword } = c.req.valid("json");

        const result = await authFlows.passwordReset.complete({
          token,
          newPassword,
        });
        if (!result.ok) {
          if (result.reason === "policy_failed") {
            return c.json({ message: result.message }, 400);
          }
          const status = result.status >= 500 ? 500 : result.status === 401 ? 401 : 400;
          return jsonError(c, result.message, status);
        }

        const sessionToken = await auth.session.create(c, result.userId);
        log.info("Password reset completed", { uid: result.user.uid });
        return c.json({ user: result.user, session_token: sessionToken });
      },
    )
    .post(
      "/admin-login",
      describeRoute({
        tags: ["Auth"],
        summary: "Admin token login",
        description: "Hidden emergency login using a static token. Creates/ensures the local admin account.",
        responses: {
          200: jsonResponse(AuthResponseSchema, "Login successful"),
          401: jsonResponse(ErrorResponseSchema, "Invalid token"),
          503: jsonResponse(ErrorResponseSchema, "Admin login not configured"),
        },
      }),
      v("json", AdminLoginSchema),
      async (c) => {
        if (!env.ADMIN_LOGIN_TOKEN) {
          return jsonError(c, "Admin login is not configured.", 500);
        }
        const { token } = c.req.valid("json");
        const a = Buffer.from(token);
        const b = Buffer.from(env.ADMIN_LOGIN_TOKEN);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
          log.warn("Admin login failed: invalid token");
          return jsonError(c, "Invalid token.", 401);
        }

        // Ensure the admin user exists and has emergency-admin semantics. The
        // prior `DO NOTHING` could log into a pre-existing `uid='admin'` row that
        // was locally demoted (non-admin local user, or even an IPA row named
        // admin), silently bypassing the intent of the emergency endpoint.
        await sql`
        INSERT INTO auth.users (uid, provider, profile, admin, given_name, sn, display_name)
        VALUES ('admin', 'local', 'user', true, 'Admin', '', 'Admin')
        ON CONFLICT (uid) DO UPDATE SET
          provider = 'local',
          profile = 'user',
          admin = true
      `;

        const user = await accounts.users.get({ uid: "admin" });
        if (!user) return jsonError(c, "Failed to resolve admin user.", 500);

        const sessionToken = await auth.session.create(c, user.id);
        log.info("Admin login successful");
        return c.json({ session_token: sessionToken, user });
      },
    );
