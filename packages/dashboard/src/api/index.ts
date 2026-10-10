import { DASHBOARD_WIDGET_SIZES } from "@k2b/cloud/contracts";
import { type AuthContext, auth, getUserBackedActor, rateLimit, respond, v } from "@k2b/cloud/server";
import { err, fail, ok, type Result } from "@k2b/stdlib";
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
  shortcuts: z.array(ShortcutSchema).max(DASHBOARD_MAX_SHORTCUTS).default([]),
  /** The person's board in reading order, or `null` to follow the default board. */
  board: z
    .array(
      z.object({
        key: z.string().trim().min(1).max(DASHBOARD_MAX_ID_LENGTH),
        size: z.enum(DASHBOARD_WIDGET_SIZES),
      }),
    )
    .max(DASHBOARD_MAX_ITEMS)
    .refine((board) => new Set(board.map((entry) => entry.key)).size === board.length, "Each widget can be on the board once.")
    .nullable(),
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
