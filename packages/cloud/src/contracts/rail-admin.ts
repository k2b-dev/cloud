import { z } from "zod";
import { RAIL_PREFERENCES_MAX_BYTES, RailShortcutSchema } from "./rail-preferences";
import { AccessEntrySchema } from "./shared";

export const RailAccessSchema = AccessEntrySchema.extend({
  principal: z.discriminatedUnion("type", [
    z.object({ type: z.literal("authenticated") }).strict(),
    z.object({ type: z.literal("user"), userId: z.uuid() }).strict(),
    z.object({ type: z.literal("group"), groupId: z.uuid() }).strict(),
  ]),
  permission: z.literal("read"),
});
export const RailAdminEntrySchema = z.object({ shortcut: RailShortcutSchema, access: z.array(RailAccessSchema) }).strict();
const revision = z.number().int().nonnegative().max(2_147_483_647);
export const RailAdminSchema = z.object({ revision, entries: z.array(RailAdminEntrySchema) }).strict();
/** Strip presentation metadata from editor drafts before sending or persisting grants. */
export const RailAdminInputSchema = z
  .object({
    revision,
    entries: z.array(
      z
        .object({
          shortcut: RailShortcutSchema,
          access: z.array(RailAccessSchema.pick({ principal: true, permission: true })),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > RAIL_PREFERENCES_MAX_BYTES)
      ctx.addIssue({ code: "custom", message: "Global app bar configuration exceeds 16 KiB" });
    if (new Set(value.entries.map((entry) => entry.shortcut.id)).size !== value.entries.length)
      ctx.addIssue({ code: "custom", message: "Shortcut IDs must be unique" });
  });
export type RailAdminInput = z.infer<typeof RailAdminInputSchema>;
export type RailAdminState = z.infer<typeof RailAdminSchema>;
export type RailAdminEntry = z.infer<typeof RailAdminEntrySchema>;
