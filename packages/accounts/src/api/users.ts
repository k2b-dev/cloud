import { randomUUID } from "node:crypto";
import {
  AppDeviceViewSchema,
  IpaProfileFieldsSchema,
  PwaDeviceViewSchema,
  UpdateAvatarResponseSchema,
  UpdateAvatarSchema,
  UserSchema,
} from "@k2b/cloud/contracts";
import { type AuthContext, auth, getLocale, jsonResponse, requiresAdmin, respond, v } from "@k2b/cloud/server";
import { AppApprovalError, accountsAppService as accountsService, appApproval, logger, PwaError, pwaDevices } from "@k2b/cloud/services";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { app as accountsApp } from "@/config";
import {
  BaseUserSchema,
  CreateUserResponseSchema,
  CreateUserSchema,
  createPagination,
  ErrorResponseSchema,
  MessageResponseSchema,
  PaginationQuerySchema,
  PaginationResponseSchema,
  parsePagination,
  SearchQuerySchema,
} from "@/contracts";
import { createAccountsNotificationSender } from "@/notifications";
import { expectUserBackedActor, toAccountsActor } from "@/shared/actor";
import { accountsApiMessages } from "./messages";

const log = logger("accounts:admin:users");
const notificationSender = createAccountsNotificationSender(accountsApp.notifications);
const UserIdParamSchema = z.object({ id: z.uuid() });
const UserDeviceParamSchema = z.object({ id: z.uuid(), deviceId: z.uuid() });
const UserDevicesResponseSchema = z.object({ devices: z.array(AppDeviceViewSchema) });
const UserAppDevicesResponseSchema = z.object({ devices: z.array(PwaDeviceViewSchema) });
const AppDeviceRemovalResponseSchema = z.object({
  revoked: z
    .boolean()
    .describe("True only for the call that removed the phone; repeating the call answers false until the removed phone is purged"),
});

// Admin PATCH accepts the same profile fields plus `mail`. Defined standalone
// rather than `UpdateProfileSchema.extend(...)` so its refinement can treat
// `mail` as a valid sole field — the inherited refine otherwise rejects
// mail-only payloads.
const AdminUpdateUserSchema = z
  .object({
    givenname: z.string().min(1).max(120).optional(),
    sn: z.string().min(1).max(120).optional(),
    displayName: z.string().min(1).max(160).optional(),
    mail: z
      .email()
      .nullable()
      .optional()
      .describe("Email address. `null` removes it from a local full account while the installation allows accounts without email."),
    ipa: IpaProfileFieldsSchema.optional(),
  })
  .refine(
    (data) =>
      data.givenname !== undefined ||
      data.sn !== undefined ||
      data.displayName !== undefined ||
      data.mail !== undefined ||
      data.ipa !== undefined,
    { message: "At least one profile field must be provided" },
  );

const AdminUpdateResponseSchema = MessageResponseSchema;

const UsersListResponseSchema = z.object({
  users: z.array(BaseUserSchema),
  pagination: PaginationResponseSchema,
});

type CreateUserResponse = z.infer<typeof CreateUserResponseSchema>;

const ResetPasswordResponseSchema = z.object({
  message: z.string().describe("Human-readable success message"),
  password: z.string().describe("Temporary password"),
});

const CreateLoginTokenResponseSchema = z.object({
  token: z.string().describe("One-time local login token"),
  magicLink: z.string().describe("Direct magic login URL"),
  expiresInSeconds: z.number().int().positive().describe("Token lifetime in seconds"),
});

const SwitchProviderSchema = z.object({
  provider: z.enum(["local", "ipa"]),
});

const SetAdminSchema = z.object({
  admin: z.boolean(),
});

const NotifyUserSchema = z.object({
  subject: z.string().min(1).max(200).describe("Notification subject"),
  rawHtml: z.string().min(1).max(100_000).describe("HTML content of the notification"),
});

type UserBackedActor = ReturnType<typeof expectUserBackedActor>;
const deviceAdministrator = (actor: UserBackedActor) => ({ userId: actor.id, admin: actor.roles.includes("admin") });

/** Runs a device operation for an existing account and maps device-service refusals to the Accounts error contract. */
const userDeviceResult = async <T>(
  id: string,
  run: () => Promise<T>,
): Promise<Result<T> | { ok: false; error: string; code: "UNAVAILABLE"; status: 503 }> => {
  if (!(await accountsService.user.getMinimal({ id }))) return fail(err.notFound("User"));
  try {
    return ok(await run());
  } catch (error) {
    if (!(error instanceof AppApprovalError) && !(error instanceof PwaError)) throw error;
    if (error.status === 403) return fail(err.forbidden("Admin access required"));
    if (error.status === 404) return fail(err.notFound("Device"));
    // An invalid stored app sign-in configuration, such as app.url, is not a server fault.
    if (error.status === 503) return { ok: false, error: "App sign-in is unavailable", code: "UNAVAILABLE", status: 503 };
    throw error;
  }
};

const avatarHeaders = (avatarHash: string, contentType: string, byteLength: number) => ({
  "Cache-Control": "private, max-age=31536000, immutable",
  "Content-Length": String(byteLength),
  "Content-Type": contentType,
  ETag: `"${avatarHash}"`,
  Vary: "Cookie, Authorization",
});

const logLocalAdminMutation = (params: {
  actor: { id: string; uid: string };
  target: { id: string; uid: string; provider: string; profile: string; storedAdmin: boolean };
  nextAdmin: boolean;
  reason: string;
}) => {
  log.warn(params.nextAdmin ? "Local admin granted" : "Local admin revoked", {
    actorUserId: params.actor.id,
    actorUid: params.actor.uid,
    targetUserId: params.target.id,
    targetUid: params.target.uid,
    targetProvider: params.target.provider,
    targetProfile: params.target.profile,
    previousAdmin: params.target.storedAdmin,
    nextAdmin: params.nextAdmin,
    reason: params.reason,
  });
};

// Admin-only user management routes. Self-service (/me) lives in core at
// /api/me/*; this file is strictly third-party administration.
const app = new Hono<AuthContext>()
  .get(
    "/:id/avatar",
    auth.requireRole("authenticated"),
    auth.requireUser(),
    describeRoute({
      tags: ["Users"],
      summary: "Get user avatar",
      description: "Return a stored profile picture. Profile pictures are visible to user-backed authenticated actors.",
      responses: {
        200: { description: "Avatar image" },
        304: { description: "Avatar image not modified" },
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "User-backed actor required"),
        404: jsonResponse(ErrorResponseSchema, "Avatar not found"),
      },
    }),
    v("param", UserIdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const avatar = await accountsService.user.getAvatar({ id });
      if (!avatar) return c.json({ message: "Avatar not found" }, 404);

      const etag = `"${avatar.hash}"`;
      const headers = avatarHeaders(avatar.hash, avatar.contentType, avatar.bytes.length);
      if (c.req.header("if-none-match") === etag) {
        return new Response(null, { status: 304, headers });
      }
      const body = new Uint8Array(avatar.bytes);
      return new Response(body.buffer, { status: 200, headers });
    },
  )
  .use(auth.requireRole("admin"))
  .get(
    "/",
    describeRoute({
      tags: ["Users"],
      summary: "List users",
      description: "List accounts with pagination and optional search. Searches uid, display name, first/last name, and email.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(UsersListResponseSchema, "Paginated list of users"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
      },
    }),
    v(
      "query",
      z.object({
        ...PaginationQuerySchema.shape,
        ...SearchQuerySchema.shape,
        provider: z.enum(["local", "ipa"]).optional(),
        profile: z.enum(["user", "guest"]).optional(),
      }),
    ),
    async (c) => {
      const query = c.req.valid("query");
      const pagination = parsePagination(query);

      const usersPage = await accountsService.user.list({
        pagination: {
          page: pagination.page,
          perPage: pagination.perPage,
        },
        filter: { search: query.search },
        scope: { provider: query.provider, profile: query.profile },
      });

      return respond(
        c,
        ok({
          users: usersPage.items,
          pagination: createPagination(pagination, usersPage.total),
        }),
      );
    },
  )
  .get(
    "/:id",
    describeRoute({
      tags: ["Users"],
      summary: "Get user",
      description: "Return the full user resource including IPA-specific fields and group memberships.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(UserSchema, "User"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
        404: jsonResponse(ErrorResponseSchema, "User not found"),
        500: jsonResponse(ErrorResponseSchema, "FreeIPA service account unavailable"),
      },
    }),
    v("param", UserIdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      return respond(c, async () => {
        const user = await accountsService.user.get({ id });
        if (!user) return fail(err.notFound("User not found"));
        return ok(user);
      });
    },
  )
  .post(
    "/",
    describeRoute({
      tags: ["Users"],
      summary: "Create user",
      description:
        "Create a new account. FreeIPA-backed accounts get a temporary password; local accounts use magic-link login. A local full account may omit `email` while `user.local_email_optional` is on; it then signs in with a paired app or a passkey.",
      ...requiresAdmin,
      responses: {
        201: jsonResponse(CreateUserResponseSchema, "User created successfully"),
        400: jsonResponse(ErrorResponseSchema, "Invalid input or user creation failed"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
      },
    }),
    v("json", CreateUserSchema),
    async (c) => {
      const data = c.req.valid("json");
      const adminUser = expectUserBackedActor(c);

      return respond(
        c,
        async () => {
          const result: Result<CreateUserResponse> = await accountsService.user.create({
            actor: toAccountsActor(adminUser),
            data,
            processedBy: adminUser.id,
            notificationSender,
            locale: getLocale(c),
          });
          if (!result.ok) return result;
          if (data.provider === "local" && data.profile === "user" && data.admin) {
            log.warn("Local admin created", {
              actorUserId: adminUser.id,
              actorUid: adminUser.uid,
              targetUserId: result.data.id,
              targetUid: result.data.uid,
              targetProvider: "local",
              targetProfile: "user",
              previousAdmin: false,
              nextAdmin: true,
              reason: "create_local_admin",
            });
          }
          return result;
        },
        201,
      );
    },
  )
  .patch(
    "/:id",
    describeRoute({
      tags: ["Users"],
      summary: "Update user",
      description: "Update an account's profile fields (admin only).",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(AdminUpdateResponseSchema, "User updated"),
        400: jsonResponse(ErrorResponseSchema, "Failed to update user"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
      },
    }),
    v("param", UserIdParamSchema),
    v("json", AdminUpdateUserSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const data = c.req.valid("json");

      return respond(c, async () => {
        const result = await accountsService.user.update({ actor: toAccountsActor(expectUserBackedActor(c)), id, data });
        if (!result.ok) return result;
        return ok({ message: accountsApiMessages(getLocale(c)).userUpdated });
      });
    },
  )
  .put(
    "/:id/avatar",
    describeRoute({
      tags: ["Users"],
      summary: "Update user avatar",
      description: "Store a small profile picture for an account (admin only). Avatars are visible to user-backed authenticated actors.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(UpdateAvatarResponseSchema, "Avatar updated"),
        400: jsonResponse(ErrorResponseSchema, "Failed to update avatar"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
        404: jsonResponse(ErrorResponseSchema, "User not found"),
      },
    }),
    v("param", UserIdParamSchema),
    v("json", UpdateAvatarSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const data = c.req.valid("json");
      return respond(c, async () => {
        const result = await accountsService.user.setAvatar({
          actor: toAccountsActor(expectUserBackedActor(c)),
          id,
          dataUrl: data.dataUrl,
        });
        if (!result.ok) return result;
        return ok({ message: accountsApiMessages(getLocale(c)).avatarUpdated, avatarHash: result.data.avatarHash });
      });
    },
  )
  .delete(
    "/:id/avatar",
    describeRoute({
      tags: ["Users"],
      summary: "Delete user avatar",
      description: "Remove an account profile picture (admin only).",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Avatar deleted"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
        404: jsonResponse(ErrorResponseSchema, "User not found"),
      },
    }),
    v("param", UserIdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      return respond(c, async () => {
        const result = await accountsService.user.clearAvatar({ actor: toAccountsActor(expectUserBackedActor(c)), id });
        if (!result.ok) return result;
        return ok({ message: accountsApiMessages(getLocale(c)).avatarDeleted });
      });
    },
  )
  .post(
    "/:id/password-reset",
    describeRoute({
      tags: ["Users"],
      summary: "Reset user password",
      description:
        "Reset a FreeIPA user's password to a temporary generated password (admin only). The user will be forced to change it on next login.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(ResetPasswordResponseSchema, "Password reset"),
        400: jsonResponse(ErrorResponseSchema, "Failed to reset password"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
      },
    }),
    v("param", UserIdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const actor = expectUserBackedActor(c);

      return respond(c, async () => {
        const targetUser = await accountsService.user.getMinimal({ id });
        if (!targetUser) return fail(err.notFound("User not found"));
        const result = await accountsService.user.resetPassword({
          actor: toAccountsActor(actor),
          id,
        });
        if (!result.ok) return result;
        log.warn("Admin reset FreeIPA password", {
          actorUserId: actor.id,
          actorUid: actor.uid,
          targetUserId: targetUser.id,
          targetUid: targetUser.uid,
          targetProvider: targetUser.provider,
          targetProfile: targetUser.profile,
        });
        return ok({ message: accountsApiMessages(getLocale(c)).passwordReset, password: result.data.password });
      });
    },
  )
  .post(
    "/:id/login-token",
    describeRoute({
      tags: ["Users"],
      summary: "Create login token",
      description:
        "Create a one-time local login token for the target local account without sending an email. The token is bound to the account, so it also works for accounts without an email address. The emergency `admin` account is refused; use `ADMIN_LOGIN_TOKEN` for it.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(CreateLoginTokenResponseSchema, "Login token created"),
        400: jsonResponse(ErrorResponseSchema, "Failed to create login token"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required, or the target is the emergency admin account"),
        404: jsonResponse(ErrorResponseSchema, "User not found"),
      },
    }),
    v("param", UserIdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const actor = expectUserBackedActor(c);
      return respond(c, async () => {
        const targetUser = await accountsService.user.getMinimal({ id });
        if (!targetUser) return fail(err.notFound("User not found"));
        const result = await accountsService.user.createLoginToken({ actor: toAccountsActor(actor), id });
        if (!result.ok) return result;
        log.warn("Admin created local login token", {
          actorUserId: actor.id,
          actorUid: actor.uid,
          targetUserId: targetUser.id,
          targetUid: targetUser.uid,
          targetProvider: targetUser.provider,
          targetProfile: targetUser.profile,
        });
        return ok(result.data);
      });
    },
  )
  .put(
    "/:id/admin",
    describeRoute({
      tags: ["Users"],
      summary: "Set local admin access",
      description: "Grant or revoke admin access for a local full account.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Admin access updated"),
        400: jsonResponse(ErrorResponseSchema, "Failed to update admin access"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
      },
    }),
    v("param", UserIdParamSchema),
    v("json", SetAdminSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const actor = expectUserBackedActor(c);
      return respond(c, async () => {
        const targetUser = await accountsService.user.getMinimal({ id });
        if (!targetUser) return fail(err.notFound("User not found"));
        const { admin } = c.req.valid("json");
        const result = await accountsService.user.setAdmin({ actor: toAccountsActor(actor), id, admin });
        if (!result.ok) return result;
        logLocalAdminMutation({
          actor,
          target: targetUser,
          nextAdmin: admin,
          reason: "manual_set_admin",
        });
        return ok({ message: admin ? "Local admin granted." : "Local admin revoked." });
      });
    },
  )
  .put(
    "/:id/provider",
    describeRoute({
      tags: ["Users"],
      summary: "Switch account provider",
      description: "Switch an existing account between the local and FreeIPA providers while preserving the local identity row.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Provider switched"),
        400: jsonResponse(ErrorResponseSchema, "Failed to switch provider"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
      },
    }),
    v("param", UserIdParamSchema),
    v("json", SwitchProviderSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const { provider } = c.req.valid("json");

      return respond(c, async () => {
        const actor = expectUserBackedActor(c);
        const targetUser = await accountsService.user.getMinimal({ id });
        if (!targetUser) return fail(err.notFound("User not found"));
        const result = await accountsService.user.switchProvider({
          actor: toAccountsActor(actor),
          id,
          provider,
        });
        if (!result.ok) return result;
        if (provider === "ipa" && targetUser.provider === "local" && targetUser.storedAdmin) {
          logLocalAdminMutation({
            actor,
            target: targetUser,
            nextAdmin: false,
            reason: "switch_to_ipa",
          });
        }
        return ok({ message: `Account provider switched to ${provider}.` });
      });
    },
  )
  .put(
    "/:id/expiry",
    describeRoute({
      tags: ["Users"],
      summary: "Set account expiry",
      description: "Set or remove the account expiration date for an account (admin only).",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Account expiry updated"),
        400: jsonResponse(ErrorResponseSchema, "Failed to update expiry"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
      },
    }),
    v(
      "json",
      z.object({
        expiryDate: z.string().nullable().describe("ISO date or date-time string, or null to remove expiry"),
      }),
    ),
    v("param", UserIdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const { expiryDate } = c.req.valid("json");
      const actor = expectUserBackedActor(c);

      return respond(c, async () => {
        const result = await accountsService.user.setExpiry({
          actor: toAccountsActor(actor),
          id,
          expiryDate,
        });
        if (!result.ok) return result;
        return ok({
          message: expiryDate ? "Account expiry set." : "Account expiry removed.",
        });
      });
    },
  )
  .put(
    "/:id/profile",
    describeRoute({
      tags: ["Users"],
      summary: "Set local account profile",
      description: "Switch a local account between the user and guest profiles.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Account profile updated"),
        400: jsonResponse(ErrorResponseSchema, "Failed to update profile"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
      },
    }),
    v("param", UserIdParamSchema),
    v("json", z.object({ profile: z.enum(["user", "guest"]) })),
    async (c) => {
      const { id } = c.req.valid("param");
      const { profile } = c.req.valid("json");
      return respond(c, async () => {
        const actor = expectUserBackedActor(c);
        const targetUser = await accountsService.user.getMinimal({ id });
        if (!targetUser) return fail(err.notFound("User not found"));
        const result = await accountsService.user.setProfile({
          actor: toAccountsActor(actor),
          id,
          profile,
        });
        if (!result.ok) return result;
        if (profile === "guest" && targetUser.provider === "local" && targetUser.storedAdmin) {
          logLocalAdminMutation({
            actor,
            target: targetUser,
            nextAdmin: false,
            reason: "demote_to_guest",
          });
        }
        return ok({ message: `Local account switched to ${profile}.` });
      });
    },
  )
  .post(
    "/:id/notifications",
    describeRoute({
      tags: ["Users"],
      summary: "Send notification to user",
      description: "Send an email notification to the target user (admin only).",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Notification sent"),
        400: jsonResponse(ErrorResponseSchema, "Failed to send notification"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
        404: jsonResponse(ErrorResponseSchema, "User not found"),
      },
    }),
    v("param", UserIdParamSchema),
    v("json", NotifyUserSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const actor = expectUserBackedActor(c);
      const { subject, rawHtml } = c.req.valid("json");
      return respond(c, async () => {
        const result = await notificationSender.sendAdministrativeMessage({
          idempotencyKey: `admin-message:${randomUUID()}`,
          userId: id,
          subject,
          rawHtml,
          sentBy: actor.id,
          locale: getLocale(c),
        });
        if (result.status === "error" || result.status === "suppressed") {
          return fail(err.badInput("The notification could not be delivered"));
        }
        return ok({ message: accountsApiMessages(getLocale(c)).notificationSent });
      });
    },
  )
  .get(
    "/:id/devices",
    describeRoute({
      tags: ["Users"],
      summary: "List paired sign-in devices",
      description: "List the active devices that can approve sign-ins for this account through app sign-in (admin only).",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(UserDevicesResponseSchema, "Active paired devices"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
        404: jsonResponse(ErrorResponseSchema, "User not found"),
        503: jsonResponse(ErrorResponseSchema, "App sign-in configuration is invalid"),
      },
    }),
    v("param", UserIdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const actor = deviceAdministrator(expectUserBackedActor(c));
      return respond(
        c,
        userDeviceResult(id, async () => ({ devices: await appApproval.listUserDevices(actor, id) })),
      );
    },
  )
  .delete(
    "/:id/devices/:deviceId",
    describeRoute({
      tags: ["Users"],
      summary: "Revoke a paired sign-in device",
      description:
        "Revoke one of the account's paired devices so it can no longer approve sign-ins (admin only). Existing sessions stay valid. Repeating the call succeeds; the user is notified once.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Device revoked"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
        404: jsonResponse(ErrorResponseSchema, "User or device not found"),
        503: jsonResponse(ErrorResponseSchema, "App sign-in configuration is invalid"),
      },
    }),
    v("param", UserDeviceParamSchema),
    async (c) => {
      const { id, deviceId } = c.req.valid("param");
      const actor = expectUserBackedActor(c);
      return respond(
        c,
        userDeviceResult(id, async () => {
          const result = await appApproval.revokeUserDevice(deviceAdministrator(actor), id, deviceId);
          // The revocation is committed; a failed notice must not turn it into an error.
          if (result.revoked)
            await notificationSender
              .sendDeviceRevoked({ deviceId, userId: id, name: result.device.name, sentBy: actor.id, locale: getLocale(c) })
              .catch((error) => log.error("Device revocation notice failed", { targetUserId: id, deviceId, error: String(error) }));
          return { message: accountsApiMessages(getLocale(c)).deviceRevoked };
        }),
      );
    },
  )
  .get(
    "/:id/app-devices",
    describeRoute({
      tags: ["Users"],
      summary: "List phones paired with the mobile app",
      description:
        "List the account's active phones in the mobile app (preview) with name, platform, pairing date and last use (admin only). `current` is always false here.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(UserAppDevicesResponseSchema, "Active phones"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
        404: jsonResponse(ErrorResponseSchema, "User not found"),
      },
    }),
    v("param", UserIdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const actor = deviceAdministrator(expectUserBackedActor(c));
      return respond(
        c,
        userDeviceResult(id, async () => ({ devices: await pwaDevices.listUserDevices(actor, id) })),
      );
    },
  )
  .delete(
    "/:id/app-devices/:deviceId",
    describeRoute({
      tags: ["Users"],
      summary: "Remove a phone from the mobile app",
      description:
        "Remove one of the account's phones from the mobile app (preview) and end its app sessions at once (admin only). The phone shows that it was signed out at its next request. Repeating the call succeeds with `revoked: false`; once the removed phone is purged, 30 days after removal at the earliest, the call answers 404.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(AppDeviceRemovalResponseSchema, "Phone removed, or already removed"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
        404: jsonResponse(ErrorResponseSchema, "User or phone not found, or the removed phone was purged"),
      },
    }),
    v("param", UserDeviceParamSchema),
    async (c) => {
      const { id, deviceId } = c.req.valid("param");
      const actor = deviceAdministrator(expectUserBackedActor(c));
      return respond(
        c,
        userDeviceResult(id, () => pwaDevices.revokeUserDevice(actor, id, deviceId)),
      );
    },
  )
  .post(
    "/:id/login-link",
    describeRoute({
      tags: ["Users"],
      summary: "Send login link",
      description:
        "Send a local magic login link to the target user's email address. The emergency `admin` account is refused; use `ADMIN_LOGIN_TOKEN` for it.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Login link sent"),
        400: jsonResponse(ErrorResponseSchema, "Failed to send login link"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required, or the target is the emergency admin account"),
      },
    }),
    v("param", UserIdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      return respond(c, async () => {
        const result = await accountsService.user.sendLoginLink({
          actor: toAccountsActor(expectUserBackedActor(c)),
          id,
          notificationSender,
          locale: getLocale(c),
        });
        if (!result.ok) return result;
        return ok({ message: accountsApiMessages(getLocale(c)).loginLinkSent });
      });
    },
  )
  // Permanent deletion. Demotion (IPA -> local guest) is a separate
  // operation, see POST /:id/demotion below.
  .delete(
    "/:id",
    describeRoute({
      tags: ["Users"],
      summary: "Delete user",
      description: "Permanently delete a user from FreeIPA (if applicable) and local DB.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(MessageResponseSchema, "User deleted"),
        400: jsonResponse(ErrorResponseSchema, "Failed to delete user"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
        404: jsonResponse(ErrorResponseSchema, "User not found"),
      },
    }),
    v("param", UserIdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const actor = expectUserBackedActor(c);

      return respond(c, async () => {
        const result = await accountsService.user.remove({
          id,
          actor: toAccountsActor(actor),
        });
        if (!result.ok) return result;
        return ok({ message: accountsApiMessages(getLocale(c)).userDeleted });
      });
    },
  )
  .post(
    "/:id/demotion",
    describeRoute({
      tags: ["Users"],
      summary: "Demote IPA user to local guest",
      description:
        "Converts an IPA-backed user into a local guest account, preserving the local identity row. Requires admin access and FreeIPA service-account availability.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(MessageResponseSchema, "User demoted to guest"),
        400: jsonResponse(ErrorResponseSchema, "Failed to demote user"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
        404: jsonResponse(ErrorResponseSchema, "User not found"),
      },
    }),
    v("param", UserIdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const actor = expectUserBackedActor(c);

      return respond(c, async () => {
        const result = await accountsService.user.demoteToGuest({
          id,
          actor: toAccountsActor(actor),
        });
        if (!result.ok) return result;
        return ok({ message: accountsApiMessages(getLocale(c)).userDemoted });
      });
    },
  );

export default app;
