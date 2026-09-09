import {
  createPagination,
  ErrorResponseSchema,
  MessageResponseSchema,
  PaginationQuerySchema,
  PaginationResponseSchema,
  parsePagination,
  type User,
} from "@k2b/cloud/contracts";
import { type AuthContext, auth, jsonResponse, rateLimit, requiresAdmin, requiresAuth, respond, v } from "@k2b/cloud/server";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { type Context, Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { notificationsService } from "./service";

const UpdateNotificationSchema = z.object({
  subject: z.string().min(1).optional().describe("Notification subject"),
  content: z.string().optional().describe("Content (HTML)"),
  recipient: z.email().optional().describe("Recipient email"),
});

const NotificationStatusSchema = z.enum(["sent", "pending", "error"]);

const NotificationSchema = z.object({
  id: z.uuid(),
  type: z.enum(["email"]),
  recipient: z.string(),
  subject: z.string(),
  content: z.string(),
  sentAt: z.string().datetime().nullable(),
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
  sentBy: z.uuid().nullable(),
  sentByName: z.string().nullable(),
  status: z.enum(["sent", "pending", "error"]),
});

const NotificationListResponseSchema = z.object({
  notifications: z.array(NotificationSchema),
  pagination: PaginationResponseSchema,
});

const NotificationSummaryResponseSchema = z.object({
  sent: z.number(),
  pending: z.number(),
  error: z.number(),
});

/**
 * Normalizes notification date fields for API responses.
 */
const toNotificationDto = (notification: Awaited<ReturnType<typeof notificationsService.notification.list>>["items"][number]) => ({
  ...notification,
  sentAt: notification.sentAt?.toISOString() ?? null,
  createdAt: notification.createdAt.toISOString(),
});

const getUserBackedActor = (c: Context<AuthContext>) => {
  const actor = c.get("actor");
  return actor.kind === "user" ? actor.user : actor.delegatedUser;
};

const requireUserBackedActor = (c: Context<AuthContext>): Result<User> => {
  const user = getUserBackedActor(c);
  if (!user) return fail(err.forbidden("Notifications require a user-backed actor"));
  return ok(user);
};

/**
 * Loads a notification and enforces owner/admin visibility checks for subsequent mutation routes.
 */
const requireNotificationAccess = async (
  c: Context<AuthContext>,
  config: {
    id: string;
    user: AuthContext["Variables"]["user"];
  },
) => {
  const notification = await notificationsService.notification.get({
    id: config.id,
  });

  if (!notification) {
    return {
      notification: null,
      error: await respond(c, fail(err.notFound("Notification"))),
    };
  }

  if (!config.user.roles.includes("admin") && notification.sentBy !== config.user.id) {
    return {
      notification: null,
      error: await respond(c, fail(err.forbidden("Access denied"))),
    };
  }

  return { notification };
};

/**
 * Wraps mutation results and returns a standardized message payload for API handlers.
 */
const respondMessage = async (
  c: Context,
  resultPromise: Promise<
    | { ok: true; data: void }
    | {
        ok: false;
        error: {
          code: string;
          message: string;
          status: 400 | 401 | 403 | 404 | 409 | 500;
        };
      }
  >,
  message: string,
) => {
  return respond(c, async () => {
    const result = await resultPromise;
    if (!result.ok) return result;
    return ok({ message });
  });
};

/** Notification routes - available to all authenticated users. */
const app = new Hono<AuthContext>()
  .use(rateLimit())
  .use(auth.requireRole("authenticated"))
  // List notifications (admins see all, users see own)
  .get(
    "/",
    describeRoute({
      tags: ["Notifications"],
      summary: "List notifications",
      description: "List notifications. Admins see all notifications, regular users see only their own sent notifications.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(NotificationListResponseSchema, "List of notifications"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
      },
    }),
    v("query", PaginationQuerySchema.extend({ search: z.string().optional(), status: NotificationStatusSchema.optional() })),
    async (c) => {
      const user = requireUserBackedActor(c);
      if (!user.ok) return respond(c, user);

      const query = c.req.valid("query");
      const pagination = parsePagination(query);

      const { items, total } = await notificationsService.notification.list({
        pagination,
        access: {
          isAdmin: user.data.roles.includes("admin"),
          sentBy: user.data.id,
          search: query.search,
          status: query.status,
        },
      });

      return respond(
        c,
        ok({
          notifications: items.map(toNotificationDto),
          pagination: createPagination(pagination, total),
        }),
      );
    },
  )
  // Get recent notification status summary
  .get(
    "/summary",
    describeRoute({
      tags: ["Notifications"],
      summary: "Get notification status summary",
      description: "Get counts by current notification status for entries created in the last seven days.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(NotificationSummaryResponseSchema, "Notification status summary"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
      },
    }),
    async (c) => {
      const user = requireUserBackedActor(c);
      if (!user.ok) return respond(c, user);
      return respond(
        c,
        ok(
          await notificationsService.notification.summary({
            access: {
              isAdmin: user.data.roles.includes("admin"),
              sentBy: user.data.id,
            },
            days: 7,
          }),
        ),
      );
    },
  )
  // Get single notification
  .get(
    "/:id",
    describeRoute({
      tags: ["Notifications"],
      summary: "Get notification by ID",
      description: "Get a single notification. Admins can access any notification, users can only access their own.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(NotificationSchema, "Notification details"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Notification not found"),
      },
    }),
    async (c) => {
      const user = requireUserBackedActor(c);
      if (!user.ok) return respond(c, user);
      const id = c.req.param("id");
      if (!id) return respond(c, fail(err.badInput("Missing notification ID")));
      const notificationCheck = await requireNotificationAccess(c, { id, user: user.data });
      if (notificationCheck.error || !notificationCheck.notification) {
        return notificationCheck.error!;
      }

      return respond(c, ok(toNotificationDto(notificationCheck.notification)));
    },
  )
  // Resend notification
  .post(
    "/:id/resend",
    describeRoute({
      tags: ["Notifications"],
      summary: "Resend notification",
      description: "Retry sending a failed or pending notification. Admins can resend any, users only their own.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Notification resent"),
        400: jsonResponse(ErrorResponseSchema, "Failed to resend notification"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Notification not found"),
      },
    }),
    async (c) => {
      const user = requireUserBackedActor(c);
      if (!user.ok) return respond(c, user);
      const id = c.req.param("id");
      if (!id) return respond(c, fail(err.badInput("Missing notification ID")));
      const notificationCheck = await requireNotificationAccess(c, { id, user: user.data });
      if (notificationCheck.error || !notificationCheck.notification) {
        return notificationCheck.error!;
      }

      return respondMessage(c, notificationsService.notification.resend({ id }), "Notification resent");
    },
  )
  // Get pending system notifications count
  .get(
    "/pending-system/count",
    describeRoute({
      tags: ["Notifications"],
      summary: "Get pending system notifications count",
      description: "Get the count of pending system notifications (those without a sender). Admin only.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(z.object({ count: z.number() }), "Pending count"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
      },
    }),
    auth.requireRole("admin"),
    async (c) => {
      const count = await notificationsService.system.pendingCount();
      return respond(c, ok({ count }));
    },
  )
  // Send all pending system notifications
  .post(
    "/pending-system/send-all",
    describeRoute({
      tags: ["Notifications"],
      summary: "Send all pending system notifications",
      description: "Send all pending system notifications (those without a sender, e.g., welcome emails). Admin only.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(
          z.object({
            sent: z.number().describe("Number of successfully sent notifications"),
            failed: z.number().describe("Number of failed notifications"),
            errors: z.array(
              z.object({
                id: z.string(),
                recipient: z.string(),
                error: z.string(),
              }),
            ),
          }),
          "Send result",
        ),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
      },
    }),
    auth.requireRole("admin"),
    async (c) => {
      return respond(c, notificationsService.system.sendAllPending());
    },
  )
  // Update notification (only pending/error)
  .patch(
    "/:id",
    describeRoute({
      tags: ["Notifications"],
      summary: "Update notification",
      description: "Update a pending or failed notification. Cannot edit sent notifications. Admins can update any, users only their own.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Notification updated"),
        400: jsonResponse(ErrorResponseSchema, "Failed to update notification"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Notification not found"),
      },
    }),
    v("json", UpdateNotificationSchema),
    async (c) => {
      const user = requireUserBackedActor(c);
      if (!user.ok) return respond(c, user);
      const id = c.req.param("id");
      if (!id) return respond(c, fail(err.badInput("Missing notification ID")));
      const notificationCheck = await requireNotificationAccess(c, { id, user: user.data });
      if (notificationCheck.error || !notificationCheck.notification) {
        return notificationCheck.error!;
      }

      const data = c.req.valid("json");
      return respondMessage(
        c,
        notificationsService.notification.update({
          id,
          data,
          access: { isAdmin: user.data.roles.includes("admin") },
        }),
        "Notification updated",
      );
    },
  );

export default app;
export type ApiType = typeof app;
