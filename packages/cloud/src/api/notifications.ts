import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { NotificationInboxQuerySchema, NotificationInboxResponseSchema } from "../contracts/notification-inbox";
import { ErrorResponseSchema } from "../contracts/shared";
import { respond } from "../server/api";
import { type AuthContext, auth } from "../server/middleware/auth";
import { noTransform } from "../server/middleware/no-transform";
import { jsonResponse } from "../server/middleware/openapi";
import { rateLimit } from "../server/middleware/rate-limit";
import { v } from "../server/middleware/validator";
import { notificationInbox } from "../services/notifications/inbox";

export const notificationRoutes = new Hono<AuthContext>()
  .use("*", noTransform())
  .use(rateLimit())
  .use(auth.requireRole("authenticated"))
  .get(
    "/inbox",
    describeRoute({
      tags: ["Notifications"],
      summary: "Read the authenticated service account's notification inbox",
      description:
        "Service accounts may read only their own delivered inbox content. API-key scope restrictions and OAuth read/admin scopes apply. Resource-bound accounts see only their exact app/type/resource binding. User-delegated accounts cannot read this inbox.",
      security: [{ bearerAuth: [] }],
      responses: {
        200: jsonResponse(NotificationInboxResponseSchema, "Own notification inbox, newest first"),
        400: jsonResponse(ErrorResponseSchema, "Invalid pagination"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Non-delegated service account with read authority required"),
      },
    }),
    v("query", NotificationInboxQuerySchema),
    async (c) => {
      c.header("Cache-Control", "private, no-store");
      return respond(c, await notificationInbox.list({ authority: auth.getAuthority(c), ...c.req.valid("query") }));
    },
  );
