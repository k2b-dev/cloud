import { z } from "zod";

/** Rail settings travel with each SSR page: budget the complete snapshot at 16 KiB. */
export const RAIL_PREFERENCES_MAX_BYTES = 16 * 1024;
const id = z.string().trim().min(1).max(120);

export const isRailShortcutHref = (value: string): boolean => {
  if (/[\u0000-\u0020\u007f\\]/.test(value)) return false;
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
};

export const RailShortcutSchema = z.discriminatedUnion("kind", [
  z.object({ id, kind: z.literal("app"), appId: id }).strict(),
  z
    .object({
      id,
      kind: z.literal("link"),
      title: z.string().trim().min(1).max(80),
      href: z.string().trim().min(1).max(2000).refine(isRailShortcutHref, "Use an absolute path or an HTTP(S) URL"),
      icon: z
        .string()
        .regex(/^ti ti-[a-z0-9-]+$/)
        .max(120),
    })
    .strict(),
]);
export type RailShortcut = z.infer<typeof RailShortcutSchema>;

export const RailPreferencesSchema = z
  .object({
    revision: z.number().int().nonnegative().max(2_147_483_647),
    visibility: z.record(id, z.boolean()),
    shortcuts: z.array(RailShortcutSchema),
    /** On wide windows the app bar shows each entry's name beside its icon; off keeps the icon bar. */
    showNames: z.boolean().default(true),
  })
  .strict()
  .superRefine(({ showNames: _fixedSize, ...value }, ctx) => {
    // The budget measures what grows with the person's choices. The fixed-size names flag stays outside it, so settings
    // saved at the budget before the flag existed still load.
    if (new TextEncoder().encode(JSON.stringify({ ...value, revision: 2_147_483_647 })).byteLength > RAIL_PREFERENCES_MAX_BYTES) {
      ctx.addIssue({ code: "custom", message: "App bar settings exceed the 16 KiB page budget" });
    }
    if (new Set(value.shortcuts.map((entry) => entry.id)).size !== value.shortcuts.length) {
      ctx.addIssue({ code: "custom", message: "Shortcut IDs must be unique" });
    }
    const apps = value.shortcuts.flatMap((entry) => (entry.kind === "app" ? [entry.appId] : []));
    if (new Set(apps).size !== apps.length) ctx.addIssue({ code: "custom", message: "An app can only be pinned once" });
  });
export type RailPreferences = z.infer<typeof RailPreferencesSchema>;
export const defaultRailPreferences = (): RailPreferences => ({ revision: 0, visibility: {}, shortcuts: [], showNames: true });

/** Managed entries are separate from the writable personal API contract. */
export type RailSnapshot = RailPreferences & { managedShortcuts?: RailShortcut[] };
export const RailSnapshotSchema = z
  .object({
    revision: z.number(),
    visibility: z.record(z.string(), z.boolean()),
    shortcuts: z.array(RailShortcutSchema),
    showNames: z.boolean().default(true),
    managedShortcuts: z.array(RailShortcutSchema).optional(),
  })
  .strict()
  .superRefine(({ managedShortcuts, ...personal }, ctx) => {
    if (!RailPreferencesSchema.safeParse(personal).success) ctx.addIssue({ code: "custom", message: "Invalid personal app bar settings" });
    if (new TextEncoder().encode(JSON.stringify(managedShortcuts ?? [])).byteLength > RAIL_PREFERENCES_MAX_BYTES)
      ctx.addIssue({ code: "custom", message: "Managed shortcuts exceed the 16 KiB page budget" });
  });
