import { z } from "zod";
import { ShortIdSchema } from "./contracts";

// Navigation is a bounded base configuration, not a second resource store.
export const NAVIGATION_MAX_BYTES = 64 * 1024;
export const NavigationResourceTypeSchema = z.enum(["table", "view", "form", "documentTemplate", "workflow", "customApp"]);
export const NavigationReferenceSchema = z.object({ type: NavigationResourceTypeSchema, id: ShortIdSchema }).strict();
export const NavigationGroupSchema = z
  .object({
    id: ShortIdSchema,
    name: z.string().trim().min(1).max(200),
    entries: z.array(NavigationReferenceSchema),
  })
  .strict();
export const NavigationGroupsSchema = z.array(NavigationGroupSchema).superRefine((groups, ctx) => {
  if (new TextEncoder().encode(JSON.stringify(groups)).length > NAVIGATION_MAX_BYTES)
    ctx.addIssue({ code: "custom", message: "Navigation exceeds the 64 KiB configuration budget." });
  if (new Set(groups.map((group) => group.id)).size !== groups.length)
    ctx.addIssue({ code: "custom", message: "Group IDs must be unique." });
  for (const group of groups) {
    if (new Set(group.entries.map(navigationReferenceKey)).size !== group.entries.length)
      ctx.addIssue({ code: "custom", message: "A resource may appear only once per group." });
  }
});
export const BaseNavigationSchema = z.object({ revision: z.number().int().nonnegative(), groups: NavigationGroupsSchema }).strict();
export type NavigationReference = z.infer<typeof NavigationReferenceSchema>;
export type NavigationGroup = z.infer<typeof NavigationGroupSchema>;
export type BaseNavigation = z.infer<typeof BaseNavigationSchema>;
export const navigationReferenceKey = (ref: NavigationReference): string => `${ref.type}:${ref.id}`;

/** Project only through an already-authorized catalog. Never expose hidden references. */
export const visibleNavigationGroups = (groups: readonly NavigationGroup[], visible: ReadonlySet<string>): NavigationGroup[] =>
  groups
    .map((group) => ({ ...group, entries: group.entries.filter((entry) => visible.has(navigationReferenceKey(entry))) }))
    .filter((group) => group.entries.length > 0);
