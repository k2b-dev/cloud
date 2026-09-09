/**
 * Self-service endpoints — everything a logged-in user does with their OWN
 * account. Owned by core, mounted at /api/me/*. Auth flows live in /auth;
 * third-party management lives in the accounts admin app.
 */

import { ok } from "@k2b/stdlib";
import { Hono, type MiddlewareHandler } from "hono";
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
  RegisterBrowserNotificationEndpointSchema,
  ServiceAccountCredentialSchema,
  UpdateAvatarResponseSchema,
  UpdateAvatarSchema,
  UpdateProfileSchema,
  UpdateUserNotificationPreferenceSchema,
  UserNotificationHistoryResponseSchema,
  UserNotificationPreferenceSchema,
  UserNotificationPreferencesResponseSchema,
  UserSchema,
  WebAuthnPasskeySchema,
} from "../contracts";
import { CapabilityAppIdSchema } from "../contracts/capabilities";
import { type AuthContext, auth, getLocale, jsonResponse, rateLimit, requiresAuth, respond, v } from "../server";
import {
  accountLifecycle,
  accountsAppService as accountsService,
  audit,
  browserNotifications,
  mandates,
  notifications,
  serviceAccountCredentials,
  webauthn,
} from "../services";
import { MandatePolicyV1Schema } from "../services/mandates";

import { createMeRailRoutes } from "./me-rail";

const toAccountsActor = (user: AuthContext["Variables"]["user"]) => ({
  userId: user.id,
  uid: user.uid,
  roles: user.roles,
  provider: user.provider,
});

/**
 * Guards the endpoints that manage how the account is authenticated: passkeys,
 * API keys, the password, and account deletion.
 *
 * `auth.requireUser()` is not enough for these. A personal API key acts as
 * its user, so it passes that check — and could then enrol a passkey, which is
 * a full account takeover, or mint further keys that outlive the revocation of
 * the one that was leaked. No scope in the vocabulary means "may add an
 * authenticator", so a credential must not reach these endpoints at all.
 *
 * A credential may still *read* its account's passkeys and keys; only the
 * mutations are gated. Browser sessions and user-issued OAuth access tokens
 * both resolve to a `user` actor and are unaffected.
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
  return next();
});

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
  .use(rateLimit())
  .use(auth.requireRole("authenticated"))
  .use(auth.requireUser())
  .route("/", mandateRoutes)
  .route("/", createMeRailRoutes())

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
    describeRoute({
      tags: ["Me"],
      summary: "Register browser notification endpoint",
      description: "Register or refresh a Web Push subscription for the authenticated account.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(BrowserNotificationEndpointSchema, "Registered browser notification endpoint"),
        400: jsonResponse(ErrorResponseSchema, "Invalid browser subscription"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
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
      },
    }),
    v("json", UpdateProfileSchema),
    async (c) =>
      respond(c, async () => {
        const user = c.get("user");
        const data = c.req.valid("json");
        const result = await accountsService.user.update({ actor: toAccountsActor(user), id: user.id, data });
        if (!result.ok) return result;
        return ok({ message: "Profile updated." });
      }),
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
    requireDirectUserActor,
    describeRoute({
      tags: ["Me"],
      summary: "Start passkey registration",
      description: "Create WebAuthn registration options for the authenticated account.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(z.unknown(), "Passkey registration options"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Not permitted for API keys or other credentials"),
      },
    }),
    async (c) => respond(c, webauthn.beginRegistration({ user: c.get("user") })),
  )

  .post(
    "/passkeys/registration/verify",
    requireDirectUserActor,
    describeRoute({
      tags: ["Me"],
      summary: "Verify passkey registration",
      description: "Verify a WebAuthn registration response and store the passkey public credential.",
      ...requiresAuth,
      responses: {
        201: jsonResponse(WebAuthnPasskeySchema, "Passkey created"),
        400: jsonResponse(ErrorResponseSchema, "Passkey registration failed"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Not permitted for API keys or other credentials"),
      },
    }),
    v("json", CreateWebAuthnPasskeySchema),
    async (c) =>
      respond(
        c,
        () => {
          const data = c.req.valid("json");
          return webauthn.finishRegistration({
            user: c.get("user"),
            name: data.name,
            response: data.response as never,
          });
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
    requireDirectUserActor,
    describeRoute({
      tags: ["Me"],
      summary: "Create current user API key",
      description: "Create a user-bound API key for the authenticated account. The raw token is returned once.",
      ...requiresAuth,
      responses: {
        201: jsonResponse(CreateUserApiKeyResponseSchema, "API key created"),
        400: jsonResponse(ErrorResponseSchema, "Failed to create API key"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Not permitted for API keys or other credentials"),
      },
    }),
    v("json", CreateUserApiKeySchema),
    async (c) =>
      respond(
        c,
        async () => {
          const user = c.get("user");
          const data = c.req.valid("json");
          return serviceAccountCredentials.createUserApiToken({
            user,
            name: data.name,
            expiresAt: data.expiresAt ?? null,
          });
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
      description: "Change the authenticated user's password. Requires the current password for verification.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Password changed"),
        400: jsonResponse(ErrorResponseSchema, "Failed to change password"),
        401: jsonResponse(ErrorResponseSchema, "Current password is incorrect"),
        403: jsonResponse(ErrorResponseSchema, "Not permitted for API keys or other credentials"),
      },
    }),
    v("json", ChangePasswordSchema),
    async (c) =>
      respond(c, async () => {
        const result = await accountsService.user.changeOwnPassword({
          user: c.get("user"),
          currentPassword: c.req.valid("json").currentPassword,
          newPassword: c.req.valid("json").newPassword,
        });
        if (!result.ok) return result;
        return ok({ message: "Password changed successfully." });
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
