import { ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import {
  ActiveAnnouncementsResponseSchema,
  AnnouncementEntrySchema,
  AnnouncementListResponseSchema,
  CreateAnnouncementSchema,
  ErrorResponseSchema,
  MessageResponseSchema,
  parseAnnouncementCookieHeader,
  UpdateAnnouncementSchema,
} from "../contracts";
import { type AuthContext, auth, jsonResponse, requiresAdmin, requiresAuth, respond, v } from "../server";
import { announcements } from "../services";

const IdParamSchema = z.object({ id: z.uuid() });

const withMessage = async <T>(operation: Promise<import("@k2b/stdlib").Result<T>>, message: string) => {
  const result = await operation;
  if (!result.ok) return result;
  return ok({ message });
};

export const announcementRoutes = new Hono<AuthContext>().get(
  "/active",
  auth.requireRole("authenticated"),
  describeRoute({
    tags: ["Announcements"],
    summary: "List active user announcements",
    description: "Returns active banners and unseen announcements for the current request cookie state.",
    ...requiresAuth,
    responses: {
      200: jsonResponse(ActiveAnnouncementsResponseSchema, "Active announcements"),
      401: jsonResponse(ErrorResponseSchema, "Authentication required"),
    },
  }),
  async (c) => {
    const state = parseAnnouncementCookieHeader(c.req.header("Cookie"));
    return respond(c, ok(await announcements.active.forState({ state })));
  },
);

export const adminAnnouncementRoutes = new Hono<AuthContext>()
  .use(auth.requireRole("admin"))
  .delete(
    "/cache",
    describeRoute({
      tags: ["Admin Announcements"],
      summary: "Invalidate announcement cache",
      ...requiresAdmin,
      responses: { 200: jsonResponse(z.object({ success: z.literal(true) }), "Cache invalidated") },
    }),
    async (c) => {
      await announcements.admin.invalidateCache(c.get("user"));
      c.header("Cache-Control", "no-store");
      return c.json({ success: true as const });
    },
  )
  .get(
    "/",
    describeRoute({
      tags: ["Admin Announcements"],
      summary: "List announcements",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(AnnouncementListResponseSchema, "Announcements"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
      },
    }),
    v(
      "query",
      z.object({
        kind: z.enum(["announcement", "banner"]).optional(),
        search: z.string().optional(),
      }),
    ),
    async (c) => {
      const query = c.req.valid("query");
      const items = await announcements.admin.list({
        filter: { kind: query.kind, query: query.search },
      });
      return respond(c, ok({ items }));
    },
  )
  .post(
    "/",
    describeRoute({
      tags: ["Admin Announcements"],
      summary: "Create announcement",
      ...requiresAdmin,
      responses: {
        201: jsonResponse(AnnouncementEntrySchema, "Created announcement"),
        400: jsonResponse(ErrorResponseSchema, "Validation error"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
      },
    }),
    v("json", CreateAnnouncementSchema),
    async (c) => respond(c, announcements.admin.create({ data: c.req.valid("json"), actorId: c.get("user").id }), 201),
  )
  .patch(
    "/:id",
    describeRoute({
      tags: ["Admin Announcements"],
      summary: "Update announcement",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(AnnouncementEntrySchema, "Updated announcement"),
        400: jsonResponse(ErrorResponseSchema, "Validation error"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
        404: jsonResponse(ErrorResponseSchema, "Announcement not found"),
      },
    }),
    v("param", IdParamSchema),
    v("json", UpdateAnnouncementSchema),
    async (c) =>
      respond(
        c,
        announcements.admin.update({
          id: c.req.valid("param").id,
          data: c.req.valid("json"),
          actorId: c.get("user").id,
        }),
      ),
  )
  .delete(
    "/:id",
    describeRoute({
      tags: ["Admin Announcements"],
      summary: "Delete announcement",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Announcement deleted"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
        404: jsonResponse(ErrorResponseSchema, "Announcement not found"),
      },
    }),
    v("param", IdParamSchema),
    async (c) => respond(c, withMessage(announcements.admin.remove({ id: c.req.valid("param").id }), "Announcement deleted.")),
  );
