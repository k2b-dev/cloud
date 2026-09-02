import { z } from "zod";

/**
 * Widget JSON contract — what an app's widget endpoint must return when the
 * dashboard fetches it. Each block maps 1:1 to a `<Widget*>` SolidJS component
 * (see the portable `@k2b/ui` widget primitives).
 *
 * The dashboard sends the user's credential only to Core. Core calls the
 * framework-owned target handler with an exact invocation; the handler remains
 * responsible for permission gating:
 *   - `200` + body  → render
 *   - `403`         → list as unavailable at the user's access level
 *   - `204`         → skip silently because there is no content
 *   - anything else → log and render an error placeholder
 */

export const WIDGET_MAX_RESPONSE_BYTES = 128 * 1024;

const WidgetTextSchema = z.string().max(10_000);
const WidgetLabelSchema = z.string().max(500);
const WidgetIconSchema = z.string().max(120);
const WidgetClassSchema = z.string().max(500);
const isSafeWidgetHref = (value: string): boolean => {
  if (/[\\\u0000-\u001f\u007f-\u009f]/u.test(value)) return false;
  try {
    const url = new URL(value, "https://cloud.invalid");
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};
const WidgetHrefSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(isSafeWidgetHref, "Widget links must be relative paths or HTTP(S) URLs without control characters or backslashes");

export const WidgetToneSchema = z.enum(["emerald", "amber", "red", "blue", "zinc"]);
export type WidgetTone = z.infer<typeof WidgetToneSchema>;

export type DashboardWidgetZone = "focus" | "overview" | "context";
export type DashboardWidgetSpan = "standard" | "wide";

/**
 * Stable, app-owned recommendation for a widget's initial dashboard layout.
 * Explicit user layout settings always take precedence.
 */
export type DashboardWidgetPresentation = {
  defaultZone?: DashboardWidgetZone;
  defaultSpan?: DashboardWidgetSpan;
};

export const WidgetAccentSchema = z
  .object({
    tone: WidgetToneSchema,
    icon: WidgetIconSchema,
    text: WidgetLabelSchema.optional(),
  })
  .strip();

export type WidgetAccent = z.infer<typeof WidgetAccentSchema>;

export const WidgetStatBlockSchema = z
  .object({
    kind: z.literal("stat"),
    value: z.union([WidgetTextSchema, z.number()]),
    label: WidgetLabelSchema,
    sub: WidgetTextSchema.optional(),
    valueClass: WidgetClassSchema.optional(),
    accent: WidgetAccentSchema.optional(),
    grow: z.boolean().optional(),
  })
  .strip();
export type WidgetStatBlock = z.infer<typeof WidgetStatBlockSchema>;

export const WidgetListItemSchema = z
  .object({
    icon: WidgetIconSchema.optional(),
    iconTone: WidgetToneSchema.optional(),
    label: WidgetLabelSchema,
    sub: WidgetTextSchema.optional(),
    meta: WidgetLabelSchema.optional(),
    href: WidgetHrefSchema.optional(),
  })
  .strip();
export type WidgetListItem = z.infer<typeof WidgetListItemSchema>;

export const WidgetListBlockSchema = z
  .object({
    kind: z.literal("list"),
    items: z.array(WidgetListItemSchema).max(100),
    emptyMessage: WidgetTextSchema.optional(),
    grow: z.boolean().optional(),
  })
  .strip();
export type WidgetListBlock = z.infer<typeof WidgetListBlockSchema>;

export const WidgetStatusBlockSchema = z
  .object({
    kind: z.literal("status"),
    tone: z.enum(["ok", "warn", "error", "info"]),
    title: WidgetLabelSchema,
    message: WidgetTextSchema.optional(),
    icon: WidgetIconSchema.optional(),
    grow: z.boolean().optional(),
  })
  .strip();
export type WidgetStatusBlock = z.infer<typeof WidgetStatusBlockSchema>;

export const WidgetPillSchema = z
  .object({
    label: WidgetLabelSchema,
    value: z.union([WidgetTextSchema, z.number()]),
    tone: WidgetToneSchema.optional(),
    href: WidgetHrefSchema.optional(),
  })
  .strip();
export type WidgetPill = z.infer<typeof WidgetPillSchema>;

export const WidgetPillsBlockSchema = z
  .object({
    kind: z.literal("pills"),
    pills: z.array(WidgetPillSchema).max(50),
    grow: z.boolean().optional(),
  })
  .strip();
export type WidgetPillsBlock = z.infer<typeof WidgetPillsBlockSchema>;

/**
 * Compact empty state for unavailable or absent widget content.
 * The dashboard renders this through the shared Core Placeholder component.
 */
export const WidgetPlaceholderBlockSchema = z
  .object({
    kind: z.literal("placeholder"),
    title: WidgetLabelSchema,
    description: WidgetTextSchema.optional(),
    icon: WidgetIconSchema.optional(),
  })
  .strip();
export type WidgetPlaceholderBlock = z.infer<typeof WidgetPlaceholderBlockSchema>;

/**
 * Hero block — single big centred message. Use for spotlight content like a
 * quote or a single weather location. Always grows to fill available space.
 */
export const WidgetHeroBlockSchema = z
  .object({
    kind: z.literal("hero"),
    title: WidgetTextSchema,
    subtitle: WidgetTextSchema.optional(),
    icon: WidgetIconSchema.optional(),
    tone: WidgetToneSchema.optional(),
  })
  .strip();
export type WidgetHeroBlock = z.infer<typeof WidgetHeroBlockSchema>;

/** Discriminated union of every block type the dashboard can render. */
export const WidgetBlockSchema = z.discriminatedUnion("kind", [
  WidgetStatBlockSchema,
  WidgetListBlockSchema,
  WidgetStatusBlockSchema,
  WidgetPillsBlockSchema,
  WidgetPlaceholderBlockSchema,
  WidgetHeroBlockSchema,
]);
export type WidgetBlock = z.infer<typeof WidgetBlockSchema>;

/**
 * Top-level shape returned by a widget endpoint. The dashboard renders the
 * `<Widget>` container with the given title/icon/href/meta, then stacks the
 * blocks vertically — composition is open: any number, any order.
 */
export const WidgetResponseSchema = z
  .object({
    title: WidgetLabelSchema,
    icon: WidgetIconSchema.optional(),
    href: WidgetHrefSchema.optional(),
    meta: WidgetLabelSchema.optional(),
    blocks: z.array(WidgetBlockSchema).max(24),
  })
  .strip();
export type WidgetResponse = z.infer<typeof WidgetResponseSchema>;
