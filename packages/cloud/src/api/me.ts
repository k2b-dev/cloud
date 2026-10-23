/**
 * Self-service endpoints — everything a logged-in user does with their OWN
 * account. Owned by core, mounted at /api/me/*. Auth flows live in /auth;
 * third-party management lives in the accounts admin app.
 */

import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { deleteCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import {
  AccountActivityListResponseSchema,
  BrowserNotificationConfigurationSchema,
  BrowserNotificationEndpointSchema,
  BrowserPushSubscriptionSchema,
  ChangePasswordSchema,
  CreateAccountRequestSchema,
  CreateUserApiKeyResponseSchema,
  CreateUserApiKeySchema,
  CreateWebAuthnPasskeySchema,
  ErrorResponseSchema,
  ListWebAuthnPasskeysResponseSchema,
  MessageResponseSchema,
  NotificationDeliveryStatusSchema,
  NotificationQuietSettingsSchema,
  RegisterBrowserNotificationEndpointSchema,
  ServiceAccountCredentialSchema,
  SignOutOthersResponseSchema,
  UpdateAvatarResponseSchema,
  UpdateAvatarSchema,
  UpdateNotificationQuietSettingsSchema,
  UpdateProfileSchema,
  UpdateUserNotificationPreferenceSchema,
  UserNotificationHistoryResponseSchema,
  UserNotificationPreferenceSchema,
  UserNotificationPreferencesResponseSchema,
  UserSchema,
  WebAuthnPasskeySchema,
} from "../contracts";
import { CapabilityAppIdSchema } from "../contracts/capabilities";
import { type AuthContext, auth, getLocale, getTimeZone, jsonResponse, rateLimit, requiresAuth, respond, v } from "../server";
import { APP_SESSION_FORBIDDEN } from "../server/middleware/auth";
import { noTransform } from "../server/middleware/no-transform";
import {
  accountLifecycle,
  accountsAppService as accountsService,
  audit,
  browserNotifications,
  logger,
  mandates,
  notifications,
  serviceAccountCredentials,
  webauthn,
} from "../services";
import { MandatePolicyV1Schema } from "../services/mandates";
import { ConfirmedBrowserSignInError, requireConfirmedBrowserSignIn } from "../services/session/recent";
import { coreSettings } from "../services/settings/api";

import { lastingAccessApiMessages } from "./lasting-access-messages";
import { createMePanelConsentRoutes } from "./me-panel-consent";
import { createMeRailRoutes } from "./me-rail";
import { createMeWebVitalsRoutes } from "./me-web-vitals";

const log = logger("api:me");

const toAccountsActor = (user: AuthContext["Variables"]["user"]) => ({
  userId: user.id,
  uid: user.uid,
  roles: user.roles,
  provider: user.provider,
});

/** The answer for actions the mobile app's session may not take. */
const webOnly = (c: Context) => c.json(APP_SESSION_FORBIDDEN, 403);

/**
 * Guards passkey and key removal, password changes, and account deletion.
 * Browser sessions and user OAuth actors may perform these actions; personal
 * API keys and mobile app sessions may not. Adding keys and sign-in methods
 * requires a confirmed browser sign-in through the separate creation gate.
 */
const requireDirectUserActor = createMiddleware<AuthContext>(async (c, next) => {
  if (c.get("actor")?.kind !== "user") {
    return c.json(
      {
        message: "Credentials cannot manage account authentication. Sign in to change passkeys, API keys, or your password.",
        code: "FORBIDDEN",
      },
      403,
    );
  }
  if (auth.isAppSession(c)) return webOnly(c);
  return next();
});

const requireBrowserSignIn = createMiddleware<AuthContext>(async (c, next) => {
  if (!(await auth.browserSignIn(c))) {
    return c.json(
      { code: "BROWSER_SIGN_IN_REQUIRED", message: lastingAccessApiMessages.resolve([getLocale(c)]).t.browserSignInRequired },
      403,
    );
  }
  return next();
});

const lastingAccessMessage = (c: Context<AuthContext>, code: "REAUTHENTICATE" | "FORBIDDEN") => {
  const { t } = lastingAccessApiMessages.resolve([getLocale(c)]);
  return code === "REAUTHENTICATE" ? t.reauthenticate : t.forbidden;
};

/** The creation services fail with these codes only when the browser sign-in does not confirm the write. */
const localizeLastingAccessResult = <T>(c: Context<AuthContext>, result: Result<T>): Result<T> =>
  !result.ok && (result.error.code === "REAUTHENTICATE" || result.error.code === "FORBIDDEN")
    ? fail({ ...result.error, message: lastingAccessMessage(c, result.error.code) })
    : result;

const ExtendAccountResponseSchema = z.object({
  message: z.string(),
  newExpiry: z.string().datetime().optional(),
});

const AccountRequestResponseSchema = z.object({
  id: z.uuid(),
  message: z.string(),
});

const ListApiKeysResponseSchema = z.object({
  items: z.array(ServiceAccountCredentialSchema),
});

const AccountActivityQuerySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .pipe(z.union([z.literal(7), z.literal(30), z.literal(90)]))
    .optional()
    .default(30),
});
const MandateListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    perPage: z.coerce.number().int().min(1).max(100).default(50),
    state: z.enum(["active", "paused", "revoked"]).optional(),
  })
  .strict();
const CreatePendingMandateSchema = z
  .object({
    ownerAppId: CapabilityAppIdSchema,
    workloadType: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/),
    workloadId: z.string().trim().min(1).max(200),
    policy: MandatePolicyV1Schema,
    expiresAt: z.iso.datetime().nullable().optional(),
  })
  .strict();

const requireSessionMandateCreation = createMiddleware<AuthContext>(async (c, next) => {
  if (c.get("credentialKind") !== "session" || c.get("actor")?.kind !== "user") {
    return c.json({ code: "FORBIDDEN", message: "Sign in with a browser session to create background authority" }, 403);
  }
  // A mandate would keep acting after the phone is removed.
  if (auth.isAppSession(c)) return webOnly(c);
  return next();
});

type MeMandateDependencies = Pick<typeof mandates, "createPending" | "list">;

export const createMeMandateRoutes = (
  service: MeMandateDependencies = mandates,
  contextSetup: MiddlewareHandler<AuthContext> = async (_c, next) => next(),
) =>
  new Hono<AuthContext>()
    .use("*", contextSetup)
    .get("/mandates", v("query", MandateListQuerySchema), async (c) => {
      const query = c.req.valid("query");
      return c.json(
        await service.list({
          scope: { kind: "user", userId: c.get("user").id },
          pagination: { page: query.page, perPage: query.perPage },
          filter: { state: query.state },
        }),
      );
    })
    .post("/mandates", requireSessionMandateCreation, v("json", CreatePendingMandateSchema), async (c) => {
      const user = c.get("user");
      const input = c.req.valid("json");
      return respond(
        c,
        () =>
          service.createPending({
            authority: { kind: "interactive", userId: user.id },
            subject: { type: "user", id: user.id },
            ownerAppId: input.ownerAppId,
            workloadType: input.workloadType,
            workloadId: input.workloadId,
            policy: input.policy,
            expiresAt: input.expiresAt,
          }),
        201,
      );
    });

const NotificationDefinitionParamSchema = z.object({ definitionId: z.string().min(1).max(200) });
const DisableBrowserNotificationEndpointSchema = z.object({ subscription: BrowserPushSubscriptionSchema });
const NotificationHistoryQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  perPage: z.coerce.number().int().min(1).max(100).optional().default(25),
  status: NotificationDeliveryStatusSchema.optional(),
});
const mandateRoutes = createMeMandateRoutes();
const app = new Hono<AuthContext>()
  .use("/notifications/history/*", noTransform())
  .use(rateLimit())
  .use(auth.requireRole("authenticated"))
  .use(auth.requireUser())
  .route("/", mandateRoutes)
  .route("/", createMeRailRoutes())
  .route("/", createMePanelConsentRoutes())
  .route("/", createMeWebVitalsRoutes())

  .get(
    "/activity",
    describeRoute({
      tags: ["Me"],
      summary: "List current user account activity",
      description: "List safe self-service audit activity for the authenticated account.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(AccountActivityListResponseSchema, "Account activity"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
      },
    }),
    v("query", AccountActivityQuerySchema),
    async (c) =>
      respond(c, async () => {
        const page = await audit.listSelfServiceActivity({
          userId: c.get("user").id,
          days: c.req.valid("query").days,
          pagination: { page: 1, perPage: 50 },
        });
        return ok({ items: page.items });
      }),
  )

  .get(
    "/notifications/browser/configuration",
    describeRoute({
      tags: ["Me"],
      summary: "Get browser notification configuration",
      description: "Return the public Web Push application key for this Cloud deployment.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(BrowserNotificationConfigurationSchema, "Browser notification configuration"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
      },
    }),
    async (c) => respond(c, async () => ok(await browserNotifications.configuration())),
  )

  .post(
    "/notifications/browser/endpoints",
    auth.rejectAppSession,
    describeRoute({
      tags: ["Me"],
      summary: "Register browser notification endpoint",
      description: "Register or refresh a Web Push subscription for the authenticated account.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(BrowserNotificationEndpointSchema, "Registered browser notification endpoint"),
        400: jsonResponse(ErrorResponseSchema, "Invalid browser subscription"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Not available in the mobile app"),
      },
    }),
    v("json", RegisterBrowserNotificationEndpointSchema),
    async (c) => {
      const data = c.req.valid("json");
      return respond(c, async () =>
        ok(
          await browserNotifications.registerEndpoint({
            userId: c.get("user").id,
            subscription: data.subscription,
            label: data.label,
          }),
        ),
      );
    },
  )

  .delete(
    "/notifications/browser/endpoints",
    describeRoute({
      tags: ["Me"],
      summary: "Disable browser notification endpoint",
      description: "Disable a Web Push subscription owned by the authenticated account.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Browser notification endpoint disabled"),
        400: jsonResponse(ErrorResponseSchema, "Invalid browser subscription"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
      },
    }),
    v("json", DisableBrowserNotificationEndpointSchema),
    async (c) =>
      respond(c, async () => {
        await browserNotifications.disableEndpoint({
          userId: c.get("user").id,
          subscription: c.req.valid("json").subscription,
        });
        return ok({ message: "Browser notification endpoint disabled." });
      }),
  )

  .get(
    "/notifications/preferences",
    describeRoute({
      tags: ["Me"],
      summary: "List current user notification preferences",
      description: "List active user-facing notification kinds, app recommendations, required channels, and explicit preferences.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(UserNotificationPreferencesResponseSchema, "Notification preferences"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
      },
    }),
    async (c) =>
      respond(c, async () => {
        const data = await notifications.user.preferences.list(c.get("user").id, getLocale(c));
        return ok(data);
      }),
  )

  .put(
    "/notifications/preferences/:definitionId",
    describeRoute({
      tags: ["Me"],
      summary: "Set current user notification preference",
      description: "Replace optional channels for one notification kind. Required channels remain enforced by the definition.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(UserNotificationPreferenceSchema, "Updated notification preference"),
        400: jsonResponse(ErrorResponseSchema, "Invalid or unavailable channel"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        404: jsonResponse(ErrorResponseSchema, "Notification preference not found"),
      },
    }),
    v("param", NotificationDefinitionParamSchema),
    v("json", UpdateUserNotificationPreferenceSchema),
    async (c) =>
      respond(
        c,
        notifications.user.preferences.set({
          userId: c.get("user").id,
          definitionId: c.req.valid("param").definitionId,
          channels: c.req.valid("json").channels,
          locale: getLocale(c),
        }),
      ),
  )

  .delete(
    "/notifications/preferences/:definitionId",
    describeRoute({
      tags: ["Me"],
      summary: "Reset current user notification preference",
      description: "Remove an explicit preference so the app recommendation applies again.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(UserNotificationPreferenceSchema, "Reset notification preference"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        404: jsonResponse(ErrorResponseSchema, "Notification preference not found"),
      },
    }),
    v("param", NotificationDefinitionParamSchema),
    async (c) =>
      respond(
        c,
        notifications.user.preferences.reset({
          userId: c.get("user").id,
          definitionId: c.req.valid("param").definitionId,
          locale: getLocale(c),
        }),
      ),
  )

  .get(
    "/notifications/quiet",
    describeRoute({
      tags: ["Me"],
      summary: "Get current user do not disturb and quiet hours",
      description:
        "Return do not disturb, the weekly quiet hours, and whether browser notifications from every app are held back right now.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(NotificationQuietSettingsSchema, "Quiet settings and current state"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
      },
    }),
    async (c) => respond(c, async () => ok(await notifications.user.quiet.get(c.get("user").id, getTimeZone(c)))),
  )

  .patch(
    "/notifications/quiet",
    describeRoute({
      tags: ["Me"],
      summary: "Update current user do not disturb and quiet hours",
      description:
        "Pause browser notifications until a future instant at most 366 days ahead (null resumes them) or replace the weekly quiet hours. Omitted fields stay unchanged.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(NotificationQuietSettingsSchema, "Updated quiet settings and current state"),
        400: jsonResponse(ErrorResponseSchema, "Invalid quiet settings"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
      },
    }),
    v("json", UpdateNotificationQuietSettingsSchema),
    async (c) =>
      respond(
        c,
        notifications.user.quiet.update({ userId: c.get("user").id, update: c.req.valid("json"), fallbackTimeZone: getTimeZone(c) }),
      ),
  )

  .get(
    "/notifications/history",
    describeRoute({
      tags: ["Me"],
      summary: "List current user notification delivery history",
      description: "List bodyless delivery metadata and safe error details for the authenticated account.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(UserNotificationHistoryResponseSchema, "Notification delivery history"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
      },
    }),
    v("query", NotificationHistoryQuerySchema),
    async (c) =>
      respond(c, async () => {
        const query = c.req.valid("query");
        const data = await notifications.user.history.list({ userId: c.get("user").id, locale: getLocale(c), ...query });
        return ok(data);
      }),
  )

  .get(
    "/",
    describeRoute({
      tags: ["Me"],
      summary: "Get current user",
      description: "Return the authenticated user resource.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(UserSchema, "Current user"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
      },
    }),
    async (c) => respond(c, ok(c.get("user"))),
  )

  .patch(
    "/",
    describeRoute({
      tags: ["Me"],
      summary: "Update current user",
      description: "Update the authenticated user's canonical profile fields and IPA-only self-service fields.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Profile updated"),
        400: jsonResponse(ErrorResponseSchema, "Failed to update profile"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "SSH keys cannot be changed in the mobile app"),
      },
    }),
    v("json", UpdateProfileSchema),
    async (c) => {
      // SSH keys sign in to the directory's hosts and would outlive removing the phone.
      if (c.req.valid("json").ipa?.sshPublicKeys !== undefined && auth.isAppSession(c)) return webOnly(c);
      return respond(c, async () => {
        const user = c.get("user");
        const data = c.req.valid("json");
        const result = await accountsService.user.update({ actor: toAccountsActor(user), id: user.id, data });
        if (!result.ok) return result;
        return ok({ message: "Profile updated." });
      });
    },
  )

  .put(
    "/avatar",
    describeRoute({
      tags: ["Me"],
      summary: "Update current user avatar",
      description: "Store a small profile picture for the authenticated account. Avatars are visible to user-backed authenticated actors.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(UpdateAvatarResponseSchema, "Avatar updated"),
        400: jsonResponse(ErrorResponseSchema, "Failed to update avatar"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        422: jsonResponse(ErrorResponseSchema, "Malformed image container or EXIF"),
      },
    }),
    v("json", UpdateAvatarSchema),
    async (c) =>
      respond(c, async () => {
        const user = c.get("user");
        const data = c.req.valid("json");
        const result = await accountsService.user.setAvatar({
          actor: toAccountsActor(user),
          id: user.id,
          dataUrl: data.dataUrl,
        });
        if (!result.ok) return result;
        return ok({ message: "Avatar updated.", avatarHash: result.data.avatarHash });
      }),
  )

  .delete(
    "/avatar",
    describeRoute({
      tags: ["Me"],
      summary: "Delete current user avatar",
      description: "Remove the authenticated account's profile picture.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Avatar deleted"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        404: jsonResponse(ErrorResponseSchema, "User not found"),
      },
    }),
    async (c) =>
      respond(c, async () => {
        const user = c.get("user");
        const result = await accountsService.user.clearAvatar({ actor: toAccountsActor(user), id: user.id });
        if (!result.ok) return result;
        return ok({ message: "Avatar deleted." });
      }),
  )

  .get(
    "/passkeys",
    describeRoute({
      tags: ["Me"],
      summary: "List current user passkeys",
      description: "List WebAuthn passkeys registered to the authenticated account.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(ListWebAuthnPasskeysResponseSchema, "Passkeys"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
      },
    }),
    async (c) =>
      respond(c, async () => {
        const items = await webauthn.listForUser({ userId: c.get("user").id });
        return ok({ items });
      }),
  )

  .post(
    "/passkeys/registration/start",
    requireBrowserSignIn,
    describeRoute({
      tags: ["Me"],
      summary: "Start passkey registration",
      description: "Create WebAuthn registration options for the authenticated account.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(z.unknown(), "Passkey registration options"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Confirmed browser sign-in required (BROWSER_SIGN_IN_REQUIRED or REAUTHENTICATE)"),
      },
    }),
    async (c) => {
      const signIn = await auth.browserSignIn(c);
      if (!signIn) throw new Error("Browser sign-in gate was not applied");
      try {
        await requireConfirmedBrowserSignIn(sql, signIn, (code) => {
          throw new ConfirmedBrowserSignInError(code);
        });
      } catch (error) {
        if (error instanceof ConfirmedBrowserSignInError)
          return c.json({ code: error.code, message: lastingAccessMessage(c, error.code) }, 403);
        throw error;
      }
      return respond(c, webauthn.beginRegistration({ user: c.get("user") }));
    },
  )

  .post(
    "/passkeys/registration/verify",
    requireBrowserSignIn,
    describeRoute({
      tags: ["Me"],
      summary: "Verify passkey registration",
      description: "Verify a WebAuthn registration response and store the passkey public credential.",
      ...requiresAuth,
      responses: {
        201: jsonResponse(WebAuthnPasskeySchema, "Passkey created"),
        400: jsonResponse(ErrorResponseSchema, "Passkey registration failed"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Confirmed browser sign-in required (BROWSER_SIGN_IN_REQUIRED or REAUTHENTICATE)"),
      },
    }),
    v("json", CreateWebAuthnPasskeySchema),
    async (c) =>
      respond(
        c,
        async () => {
          const data = c.req.valid("json");
          const browserSignIn = await auth.browserSignIn(c);
          if (!browserSignIn) throw new Error("Browser sign-in gate was not applied");
          return localizeLastingAccessResult(
            c,
            await webauthn.finishRegistration({
              browserSignIn,
              user: c.get("user"),
              name: data.name,
              response: data.response as never,
            }),
          );
        },
        201,
      ),
  )

  .delete(
    "/passkeys/:id",
    requireDirectUserActor,
    describeRoute({
      tags: ["Me"],
      summary: "Delete current user passkey",
      description: "Delete a WebAuthn passkey registered to the authenticated account.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Passkey deleted"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Not permitted for API keys or other credentials"),
        404: jsonResponse(ErrorResponseSchema, "Passkey not found"),
      },
    }),
    async (c) =>
      respond(c, async () => {
        const result = await webauthn.deleteForUser({ user: c.get("user"), id: c.req.param("id") });
        if (!result.ok) return result;
        return ok({ message: "Passkey deleted." });
      }),
  )

  .post(
    "/api-keys",
    requireBrowserSignIn,
    describeRoute({
      tags: ["Me"],
      summary: "Create current user API key",
      description:
        "Create a personal API key with full access (default) or models-only access to the OpenAI-compatible API when enabled. The raw token is returned once.",
      ...requiresAuth,
      responses: {
        201: jsonResponse(CreateUserApiKeyResponseSchema, "API key created"),
        400: jsonResponse(ErrorResponseSchema, "Failed to create API key"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(
          ErrorResponseSchema,
          "Confirmed browser sign-in required (BROWSER_SIGN_IN_REQUIRED or REAUTHENTICATE), or models-only API turned off",
        ),
      },
    }),
    v("json", CreateUserApiKeySchema),
    async (c) =>
      respond(
        c,
        async () => {
          const user = c.get("user");
          const data = c.req.valid("json");
          if (data.access === "models" && !(await coreSettings.get<boolean>("ai.openai_api_enabled")))
            return fail(
              err.forbidden(
                "Models-only API keys are turned off. An administrator can turn on the OpenAI-compatible API in the AI settings.",
              ),
            );
          const browserSignIn = await auth.browserSignIn(c);
          if (!browserSignIn) throw new Error("Browser sign-in gate was not applied");
          return localizeLastingAccessResult(
            c,
            await serviceAccountCredentials.createUserApiToken({
              browserSignIn,
              access: data.access,
              user,
              name: data.name,
              expiresAt: data.expiresAt ?? null,
            }),
          );
        },
        201,
      ),
  )

  .get(
    "/api-keys",
    describeRoute({
      tags: ["Me"],
      summary: "List current user API keys",
      description: "List active user-bound API keys owned by the authenticated account.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(ListApiKeysResponseSchema, "API keys"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
      },
    }),
    async (c) =>
      respond(c, async () => {
        const items = await serviceAccountCredentials.listForDelegatedUser({ userId: c.get("user").id });
        return ok({ items });
      }),
  )

  .delete(
    "/api-keys/:id",
    requireDirectUserActor,
    describeRoute({
      tags: ["Me"],
      summary: "Revoke current user API key",
      description: "Revoke an API key owned by the authenticated account.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "API key revoked"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Not permitted for API keys or other credentials"),
        404: jsonResponse(ErrorResponseSchema, "API key not found"),
      },
    }),
    async (c) =>
      respond(c, async () => {
        const result = await serviceAccountCredentials.revokeForDelegatedUser({
          credentialId: c.req.param("id"),
          user: c.get("user"),
        });
        if (!result.ok) return result;
        return ok({ message: "API key revoked." });
      }),
  )

  .post(
    "/password",
    requireDirectUserActor,
    describeRoute({
      tags: ["Me"],
      summary: "Change current user password",
      description:
        "Change the authenticated user's password and end every other sign-in. Requires the current password. The current browser stays signed in with a new cookie and its original sign-in time. signInAgain is true when the caller must sign in again: this browser could not be kept, or the request did not come from a browser sign-in.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SignOutOthersResponseSchema, "Password changed"),
        400: jsonResponse(ErrorResponseSchema, "Failed to change password"),
        401: jsonResponse(ErrorResponseSchema, "Current password is incorrect"),
        500: jsonResponse(
          ErrorResponseSchema,
          "Password changed, but signing out other sign-ins failed (SIGN_OUT_OTHERS_FAILED). Retry POST /api/me/sign-ins/sign-out-others.",
        ),
        403: jsonResponse(ErrorResponseSchema, "Not permitted for API keys or other credentials"),
      },
    }),
    v("json", ChangePasswordSchema),
    async (c) =>
      respond(c, async () => {
        const keep = await auth.browserSignIn(c);
        const result = await accountsService.user.changeOwnPassword({
          keep: keep && { sid: keep.sid, authEpoch: keep.authEpoch },
          user: c.get("user"),
          currentPassword: c.req.valid("json").currentPassword,
          newPassword: c.req.valid("json").newPassword,
        });
        if (!result.ok) return result;
        if (result.data.kept) auth.session.setWebCookie(c, result.data.kept.token, result.data.kept.expiresAt);
        const signInAgain = !result.data.kept;
        if (keep && signInAgain) deleteCookie(c, "session_token", { path: "/" });
        return ok({
          message: signInAgain
            ? keep
              ? "Password changed. You are signed out everywhere, including this browser. Sign in again."
              : "Password changed. You are signed out everywhere. Sign in again."
            : "Password changed successfully.",
          signInAgain,
        });
      }),
  )

  .post(
    "/sign-ins/sign-out-others",
    auth.rejectAppSession,
    requireBrowserSignIn,
    describeRoute({
      tags: ["Me"],
      summary: "Sign out every other sign-in",
      description:
        "End other sign-ins and rotate this browser's cookie while preserving its sign-in time and expiry; signInAgain is true if this browser could not be kept. Cloud Login devices stay paired. API keys, passkeys and mandates stay valid.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SignOutOthersResponseSchema, "Other sign-ins ended"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(
          ErrorResponseSchema,
          "Browser sign-in required (BROWSER_SIGN_IN_REQUIRED); mobile app sessions receive FORBIDDEN",
        ),
        500: jsonResponse(ErrorResponseSchema, "Signing out other sign-ins failed (SIGN_OUT_OTHERS_FAILED)"),
      },
    }),
    async (c) =>
      respond(c, async () => {
        const signIn = await auth.browserSignIn(c);
        if (!signIn) throw new Error("Browser sign-in gate was not applied");
        try {
          const { kept } = await auth.session.endOtherSignIns(c.get("user").id, {
            keep: { sid: signIn.sid, authEpoch: signIn.authEpoch },
            reason: "sign_out_others",
          });
          const user = c.get("user");
          try {
            await audit.record({
              action: "auth.session.sign_out_others",
              outcome: "allowed",
              actor: toAccountsActor(user),
              target: { type: "user", id: user.id, label: user.uid, provider: user.provider },
              metadata: { keptThisBrowser: !!kept },
            });
          } catch {
            log.warn("Other sign-ins ended, but recording the audit event failed", { userId: user.id });
          }
          if (kept) auth.session.setWebCookie(c, kept.token, kept.expiresAt);
          const signInAgain = !kept;
          if (signInAgain) deleteCookie(c, "session_token", { path: "/" });
          return ok({
            message: signInAgain ? "Other sign-ins ended. Sign in again in this browser." : "Other sign-ins ended.",
            signInAgain,
          });
        } catch {
          return fail({ code: "SIGN_OUT_OTHERS_FAILED", status: 500, message: "Signing out your other sign-ins did not work. Try again." });
        }
      }),
  )

  .post(
    "/account-extension",
    describeRoute({
      tags: ["Me"],
      summary: "Extend current user account",
      description: "Extends the authenticated account according to lifecycle settings.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(ExtendAccountResponseSchema, "Account extension result"),
        400: jsonResponse(ErrorResponseSchema, "Unable to extend account"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
      },
    }),
    async (c) =>
      respond(c, async () => {
        const user = c.get("user");
        const result = await accountLifecycle.extendCurrentUserAccount({ user });
        return result;
      }),
  )

  .delete(
    "/",
    requireDirectUserActor,
    describeRoute({
      tags: ["Me"],
      summary: "Delete current user",
      description: "Delete the authenticated user's account. Only available for guest-profile users.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Account deleted"),
        400: jsonResponse(ErrorResponseSchema, "Failed to delete account"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Only guest accounts can be self-deleted"),
      },
    }),
    async (c) =>
      respond(c, async () => {
        const user = c.get("user");
        const result = await accountsService.user.removeSelf({ user });
        if (!result.ok) return result;
        await auth.session.delete(c);
        return ok({ message: "Account deleted." });
      }),
  )

  // Account request: a local user asks for an IPA-backed account. Each user
  // has at most one pending request; `POST` creates it, `DELETE` withdraws
  // the current one. Admin processing of requests lives in the accounts app.
  .post(
    "/account-request",
    describeRoute({
      tags: ["Me"],
      summary: "Submit account request",
      description: "Local accounts can request a centrally managed FreeIPA account. Must accept terms of service.",
      ...requiresAuth,
      responses: {
        201: jsonResponse(AccountRequestResponseSchema, "Request created"),
        400: jsonResponse(ErrorResponseSchema, "FreeIPA is disabled"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Only local accounts can request FreeIPA access"),
        409: jsonResponse(ErrorResponseSchema, "Pending request already exists"),
      },
    }),
    v("json", CreateAccountRequestSchema),
    async (c) => respond(c, accountsService.accountRequest.create({ user: c.get("user"), data: c.req.valid("json") }), 201),
  )

  .delete(
    "/account-request",
    describeRoute({
      tags: ["Me"],
      summary: "Withdraw pending account request",
      description: "Withdraws the current user's pending FreeIPA account request, if any.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Request withdrawn"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        404: jsonResponse(ErrorResponseSchema, "No pending request"),
      },
    }),
    async (c) =>
      respond(c, async () => {
        const user = c.get("user");
        const pending = await accountsService.accountRequest.getPendingForUser({ userId: user.id });
        if (!pending) {
          return { ok: false, error: "No pending request", status: 404 };
        }
        const result = await accountsService.accountRequest.withdraw({ id: pending.id, actor: toAccountsActor(user) });
        if (!result.ok) return result;
        return ok({ message: "Request withdrawn" });
      }),
  );

export default app;
