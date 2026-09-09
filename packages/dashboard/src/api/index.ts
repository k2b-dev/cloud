import { err, fail, ok, type Result } from "@k2b/stdlib";
import { type AuthContext, auth, getUserBackedActor, rateLimit, respond, v } from "@k2b/cloud/server";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { dashboardSettingsService } from "../service";
import {
  DASHBOARD_MAX_HREF_LENGTH,
  DASHBOARD_MAX_ID_LENGTH,
  DASHBOARD_MAX_ITEMS,
  DASHBOARD_MAX_SHORTCUTS,
  DASHBOARD_MAX_TITLE_LENGTH,
  isSafeDashboardShortcutHref,
  normalizeDashboardShortcutHref,
} from "../shared";

const ShortcutSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().trim().min(1).max(DASHBOARD_MAX_ID_LENGTH),
    kind: z.literal("app"),
    appId: z.string().trim().min(1).max(DASHBOARD_MAX_ID_LENGTH),
    title: z.string().trim().min(1).max(DASHBOARD_MAX_TITLE_LENGTH).optional(),
    icon: z.string().trim().min(1).max(DASHBOARD_MAX_ID_LENGTH).optional(),
  }),
  z.object({
    id: z.string().trim().min(1).max(DASHBOARD_MAX_ID_LENGTH),
    kind: z.literal("link"),
    href: z
      .string()
      .trim()
      .min(1)
      .max(DASHBOARD_MAX_HREF_LENGTH)
      .transform(normalizeDashboardShortcutHref)
      .refine(isSafeDashboardShortcutHref, "Use a relative, HTTP(S), or mailto link."),
    title: z.string().trim().min(1).max(DASHBOARD_MAX_TITLE_LENGTH),
    icon: z.string().trim().min(1).max(DASHBOARD_MAX_ID_LENGTH),
  }),
]);

const SettingsSchema = z.object({
  hiddenWidgets: z.array(z.string().trim().min(1).max(DASHBOARD_MAX_ID_LENGTH)).max(DASHBOARD_MAX_ITEMS).default([]),
  gradient: z.string().trim().min(1).max(DASHBOARD_MAX_ID_LENGTH).default("default"),
  shortcuts: z.array(ShortcutSchema).max(DASHBOARD_MAX_SHORTCUTS).default([]),
  layout: z
    .object({
      widgets: z
        .array(
          z.object({
            key: z.string().trim().min(1).max(DASHBOARD_MAX_ID_LENGTH),
            zone: z.enum(["focus", "overview", "context"]),
            span: z.enum(["standard", "wide"]),
          }),
        )
        .max(DASHBOARD_MAX_ITEMS)
        .default([]),
      order: z.array(z.string().trim().min(1).max(DASHBOARD_MAX_ID_LENGTH)).max(DASHBOARD_MAX_ITEMS).default([]),
    })
    .default({ widgets: [], order: [] }),
});

const requireUserBackedActor = (c: Context<AuthContext>): Result<NonNullable<ReturnType<typeof getUserBackedActor>>> => {
  const user = getUserBackedActor(c);
  if (!user) return fail(err.forbidden("Dashboard settings require a user-backed actor"));
  return ok(user);
};

const apiRoutes = new Hono<AuthContext>()
  .use(rateLimit())
  .use(auth.requireRole("authenticated"))
  .get("/settings", async (c) => {
    const user = requireUserBackedActor(c);
    if (!user.ok) return respond(c, user);
    return respond(c, ok((await dashboardSettingsService.get(user.data.id)).settings));
  })
  .put("/settings", v("json", SettingsSchema), async (c) => {
    const user = requireUserBackedActor(c);
    if (!user.ok) return respond(c, user);
    return respond(c, ok(await dashboardSettingsService.save(user.data.id, c.req.valid("json"))));
  });

export default apiRoutes;
export type ApiType = typeof apiRoutes;
