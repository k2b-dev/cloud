import { listWidgets } from "@k2b/cloud";
import {
  CAPABILITY_QUALIFIED_ID_MAX_LENGTH,
  CLOUD_RESOURCE_ID_MAX_LENGTH,
  DASHBOARD_WIDGET_SIZES,
  WIDGET_SETTING_NAME_MAX_LENGTH,
  WIDGET_SETTING_TEXT_MAX_LENGTH,
  WIDGET_SETTINGS_MAX_FIELDS,
  widgetKey,
} from "@k2b/cloud/contracts";
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
  type DashboardBoardEntry,
  hasWidgetSettings,
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

const settingName = new RegExp(`^[a-z][a-zA-Z0-9]{0,${WIDGET_SETTING_NAME_MAX_LENGTH - 1}}$`);
const EntrySettingsSchema = z
  .record(
    z
      .string()
      .max(WIDGET_SETTING_NAME_MAX_LENGTH)
      .regex(settingName)
      .refine((name) => !(name in Object.prototype)),
    z.union([
      z.string().max(WIDGET_SETTING_TEXT_MAX_LENGTH),
      z.boolean(),
      z.strictObject({
        type: z.string().min(1).max(CAPABILITY_QUALIFIED_ID_MAX_LENGTH),
        id: z.string().min(1).max(CLOUD_RESOURCE_ID_MAX_LENGTH),
        title: z.string().trim().min(1).max(DASHBOARD_MAX_TITLE_LENGTH).optional(),
      }),
    ]),
  )
  .refine((settings) => Object.keys(settings).length <= WIDGET_SETTINGS_MAX_FIELDS, "Too many widget settings.");

/**
 * The keys on `board` more than once although their widget offers no settings. `declaredWithSettings` holds every
 * running widget; a key it does not know is not judged, because its app is not running: such entries keep their
 * places on a saved board, and refusing them would fail every save while that app is down.
 */
export const repeatedKeysWithoutSettings = (
  board: readonly DashboardBoardEntry[],
  declaredWithSettings: ReadonlyMap<string, boolean>,
): string[] => {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const entry of board) {
    if (seen.has(entry.key) && declaredWithSettings.get(entry.key) === false) repeated.add(entry.key);
    seen.add(entry.key);
  }
  return [...repeated];
};

export const SettingsSchema = z.object({
  shortcuts: z.array(ShortcutSchema).max(DASHBOARD_MAX_SHORTCUTS).default([]),
  /** The person's board in reading order, or `null` to follow the default board. */
  board: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(DASHBOARD_MAX_ID_LENGTH),
        settings: EntrySettingsSchema.optional(),
        key: z.string().trim().min(1).max(DASHBOARD_MAX_ID_LENGTH),
        size: z.enum(DASHBOARD_WIDGET_SIZES),
      }),
    )
    .max(DASHBOARD_MAX_ITEMS)
    .refine((board) => new Set(board.map((entry) => entry.id)).size === board.length, "Board entry ids must be unique.")
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
    const input = c.req.valid("json");
    if (input.board && new Set(input.board.map((entry) => entry.key)).size < input.board.length) {
      // Registry downtime leaves every key unknown, so it does not block saving the board.
      const widgets = await listWidgets().catch(() => []);
      const declared = new Map(widgets.map((widget) => [widgetKey(widget.appId, widget.widgetId), hasWidgetSettings(widget)]));
      const repeated = repeatedKeysWithoutSettings(input.board, declared);
      if (repeated.length) return respond(c, fail(err.badInput(`Widgets without settings can appear only once: ${repeated.join(", ")}`)));
    }
    // Values are stored as given: the framework validates them against the declaration on every widget call, and the
    // widget's handler authorizes each chosen resource.
    return respond(c, ok(await dashboardSettingsService.save(user.data.id, input)));
  });

export default apiRoutes;
export type ApiType = typeof apiRoutes;
