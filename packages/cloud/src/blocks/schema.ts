import { chartNumberFormatSchema, chartSchema } from "@k2b/editor/chart-schema";
import { z } from "zod";
import { CODE_REQUEST_LIMITS } from "../code/request-limits";
import { CAPABILITY_MAX_REVIEW_CONTENT_BYTES } from "../contracts/capability-limits";

/** Initial SSR rendering budget. The tree takes at most half of the response envelope. */
export const BLOCK_LIMITS = Object.freeze({
  bytes: CODE_REQUEST_LIMITS.responseBytes / 2,
  depth: 12,
  nodes: 256,
  rows: 200,
  columns: 20,
  fields: 40,
  follow: 8,
  details: 100,
  stats: 6,
  trend: 60,
});
const text = z.string().max(BLOCK_LIMITS.bytes);
const contentText = z.string().max(CAPABILITY_MAX_REVIEW_CONTENT_BYTES);
const label = z.string().min(1).max(200);
const ownPath = z.string().min(1).max(CODE_REQUEST_LIMITS.urlBytes);
const scalar = z.union([text, z.number().finite(), z.boolean(), z.null()]);
const fieldName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
  .refine((value) => !["_csrf", "constructor", "prototype", "__proto__"].includes(value));
export const CodePageFieldSchema = z
  .strictObject({
    name: fieldName,
    label,
    type: z.enum(["text", "email", "number", "textarea", "select", "checkbox", "scan"]),
    value: z.union([text, z.number().finite(), z.boolean()]).optional(),
    required: z.boolean().optional(),
    /** The Code's validation message after a submit, shown at the field. */
    error: z.string().min(1).max(500).optional(),
    options: z
      .array(z.strictObject({ value: text, label }))
      .max(BLOCK_LIMITS.rows)
      .optional(),
  })
  .superRefine((field, ctx) => {
    if ((field.type === "select") !== (field.options !== undefined))
      ctx.addIssue({ code: "custom", message: "Only select fields require options" });
    if (
      field.value !== undefined &&
      (field.type === "checkbox"
        ? typeof field.value !== "boolean"
        : field.type === "number"
          ? typeof field.value !== "number"
          : typeof field.value !== "string")
    )
      ctx.addIssue({ code: "custom", message: "Field value must match its type" });
  });
/** Use the current portable chart description. Its owner moves from editor to ui/charts with the chart lane. */
export const CodeChartDescriptionSchema = chartSchema({
  maxSeries: 8,
  maxValues: BLOCK_LIMITS.rows,
  maxMarks: BLOCK_LIMITS.rows * 8,
});
export type CodeChartDescription = z.infer<typeof CodeChartDescriptionSchema>;
/** A Tabler icon class such as `ti ti-package`; a name only, never markup. */
export const blockIcon = z.string().regex(/^ti ti-[a-z0-9]+(?:-[a-z0-9]+)*$/);
/** Colours with meaning in @k2b/ui; the AI colour is not among them. */
export const blockColor = z.enum(["zinc", "blue", "emerald", "amber", "red"]);
/** A panel's share of the six grid columns; narrow pages give every panel more room, phones the whole row. */
const width = z.enum(["third", "half", "twoThirds", "full"]).optional();
/** A panel's content height: small 200 px, medium 300 px, large 400 px; a row of panels lines up when they share it. */
const height = z.enum(["sm", "md", "lg"]).optional();
/** Titles and labels as the shared description panels hold them. */
const panelTitle = z.string().min(1).max(160).regex(/\S/);
export const blockShortLabel = z.string().min(1).max(80).regex(/\S/);
/** A table's number format; units belong in the column label, as the shared tables show them. */
const tableFormat = z
  .strictObject({
    style: z.enum(["number", "percent", "currency"]).optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    decimals: z.number().int().min(0).max(10).optional(),
    compact: z.boolean().optional(),
  })
  .refine((format) => (format.style === "currency") === (format.currency !== undefined), "A currency format names its currency.");
const numberFormat = chartNumberFormatSchema();
/** One key figure: its value, how it changed and what it compares with, as the shared key-figure tiles show it. */
const stat = z.strictObject({
  label: blockShortLabel,
  value: z.union([z.number().finite(), blockShortLabel, z.null()]),
  format: numberFormat.optional(),
  icon: blockIcon.optional(),
  /** The colour of `icon`'s chip. */
  tone: blockColor.optional(),
  /** Change since the comparison: a share (0.082 is 8.2 %) or, with `unit: "points"`, percentage points. */
  delta: z
    .strictObject({ value: z.number().finite(), unit: z.literal("points").optional(), better: z.enum(["up", "down"]).optional() })
    .optional(),
  compare: z.strictObject({ label: blockShortLabel, value: z.number().finite() }).optional(),
  trend: z.array(z.number().finite()).max(BLOCK_LIMITS.trend).optional(),
});
const pageLeaf = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("Text"), text }),
  z.strictObject({ kind: z.literal("Heading"), text: label, level: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional() }),
  z.strictObject({
    kind: z.literal("Table"),
    title: panelTitle,
    subtitle: z.string().min(1).max(300).optional(),
    columns: z
      .array(
        z.strictObject({
          key: fieldName,
          label: blockShortLabel,
          /** What the column holds; it decides alignment, text and sorting. A status shows a badge from `states`. */
          type: z.enum(["text", "number", "date", "status", "bar", "amount", "flow", "delta"]).optional(),
          format: tableFormat.optional(),
          states: z
            .record(
              fieldName,
              z.strictObject({
                label: blockShortLabel,
                tone: z.enum(["info", "ok", "warning", "error", "degraded", "running", "neutral"]),
              }),
            )
            .optional(),
          /** Columns that give way first on a narrow screen: 3 below 560 px, then 2 below 420 px. */
          priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
        }),
      )
      .min(1)
      .max(BLOCK_LIMITS.columns),
    rows: z.array(z.record(z.string(), scalar)).max(BLOCK_LIMITS.rows),
    /** Shown instead of rows when there are none. */
    empty: label.optional(),
    /** A search field in the panel's head; the reader's query stays in the browser. */
    search: z.boolean().optional(),
    width,
  }),
  z.strictObject({
    kind: z.literal("Form"),
    title: label,
    action: ownPath,
    fields: z.array(CodePageFieldSchema).min(1).max(BLOCK_LIMITS.fields),
    submit: label,
    width,
  }),
  z.strictObject({
    kind: z.literal("Detail"),
    title: panelTitle,
    items: z
      .array(z.strictObject({ label: blockShortLabel, value: scalar, format: numberFormat.optional() }))
      .min(1)
      .max(BLOCK_LIMITS.details),
    width,
    height,
  }),
  /** A drawn chart, or, while there is nothing to draw, its title and what the empty frame says. */
  z.strictObject({
    kind: z.literal("Chart"),
    description: CodeChartDescriptionSchema.optional(),
    title: panelTitle.optional(),
    empty: label.optional(),
    width,
    height,
  }),
  z.strictObject({ kind: z.literal("Stats"), items: z.array(stat).min(1).max(BLOCK_LIMITS.stats) }),
  z.strictObject({ kind: z.literal("Link"), label, href: ownPath }),
  z.strictObject({ kind: z.enum(["Button", "Action"]), label, action: ownPath, values: z.record(fieldName, text).optional() }),
  z.strictObject({
    kind: z.literal("Notice"),
    tone: z.enum(["info", "success", "warning", "danger"]),
    title: label,
    text: text.optional(),
  }),
]);
type CodePageSection = {
  kind: "Section";
  title: string;
  description?: string;
  icon?: string;
  color?: z.infer<typeof blockColor>;
  children: CodePageNode[];
};
export type CodePageNode = z.infer<typeof pageLeaf> | CodePageSection;
export const CodePageNodeSchema: z.ZodType<CodePageNode> = z.lazy(() =>
  z.union([
    pageLeaf,
    z.strictObject({
      kind: z.literal("Section"),
      title: label,
      description: label.optional(),
      icon: blockIcon.optional(),
      color: blockColor.optional(),
      children: z.array(CodePageNodeSchema).max(BLOCK_LIMITS.nodes),
    }),
  ]),
);

export { BLOCK_LIMITS as CODE_PAGE_LIMITS };

/** Literal own-property paths, never expressions or prototype traversal. */
export const BlockPathSchema = z
  .array(
    z
      .string()
      .max(500)
      .refine((key) => !["__proto__", "constructor", "prototype"].includes(key)),
  )
  .max(16);
export const BlockBindingSchema = z.strictObject({ from: BlockPathSchema });
export type BlockBinding = z.infer<typeof BlockBindingSchema>;
const collection = z.array(z.unknown()).max(BLOCK_LIMITS.rows);
const states = z.record(
  fieldName,
  z.strictObject({ label: blockShortLabel, tone: z.enum(["info", "ok", "warning", "error", "degraded", "running", "neutral"]) }),
);
const detailItem = z.strictObject({
  label: blockShortLabel,
  value: z.union([contentText, z.number().finite(), z.boolean(), z.null()]),
  before: z.union([contentText, z.number().finite(), z.boolean(), z.null()]).optional(),
  format: numberFormat.optional(),
  type: z.literal("status").optional(),
  states: states.optional(),
});
const table = pageLeaf.options[2].extend({
  columns: z
    .array(
      pageLeaf.options[2].shape.columns.element
        .extend({
          key: fieldName.optional(),
          path: BlockPathSchema.optional(),
          type: z.enum(["text", "number", "date", "datetime", "status", "bar", "amount", "flow", "delta"]).optional(),
        })
        .refine((column) => (column.key !== undefined) !== (column.path !== undefined), "A column names exactly one key or path"),
    )
    .min(1)
    .max(BLOCK_LIMITS.columns),
  rows: collection,
  rowId: BlockPathSchema.optional(),
  rowHref: BlockPathSchema.optional(),
  choose: fieldName.optional(),
});
const detail = pageLeaf.options[4].extend({ items: z.array(detailItem).min(1).max(BLOCK_LIMITS.details) });
const cards = z.strictObject({
  kind: z.literal("Cards"),
  title: panelTitle,
  items: collection,
  card: z.strictObject({
    id: BlockPathSchema,
    title: BlockPathSchema,
    subtitle: BlockPathSchema.optional(),
    image: BlockPathSchema.optional(),
    imageAlt: BlockPathSchema.optional(),
    badges: BlockPathSchema.optional(),
    facts: z
      .array(z.strictObject({ label, value: BlockPathSchema }))
      .max(BLOCK_LIMITS.details)
      .optional(),
    rating: BlockPathSchema.optional(),
    price: BlockPathSchema.optional(),
    href: BlockPathSchema.optional(),
  }),
  choose: fieldName.optional(),
  empty: label.optional(),
  width,
});
const choice = z.strictObject({
  kind: z.literal("Choice"),
  id: fieldName,
  title: label,
  description: contentText.optional(),
  mode: z.enum(["one", "many"]),
  options: collection.min(1),
  option: z.strictObject({ id: BlockPathSchema, title: BlockPathSchema, subtitle: BlockPathSchema.optional() }),
  submit: label,
  // Qualified query identity is <app>.query.<local-id>. Core checks catalog existence and input later.
  then: z.strictObject({ query: z.string().max(280), input: z.record(fieldName, z.unknown()), field: fieldName }).optional(),
});
const draft = z.strictObject({
  kind: z.literal("Draft"),
  context: z
    .array(
      z.strictObject({
        label,
        value: z.union([
          contentText,
          z
            .array(
              z
                .strictObject({ name: label.optional(), address: label.optional() })
                .refine((person) => person.name !== undefined || person.address !== undefined),
            )
            .max(BLOCK_LIMITS.rows),
        ]),
      }),
    )
    .max(BLOCK_LIMITS.details)
    .optional(),
  fields: z
    .array(CodePageFieldSchema.safeExtend({ type: z.enum(["text", "textarea", "select"]), value: contentText.optional() }))
    .min(1)
    .max(BLOCK_LIMITS.fields),
});
const sharedLeaves = [
  pageLeaf.options[0].extend({ text: contentText }),
  pageLeaf.options[1],
  pageLeaf.options[3],
  pageLeaf.options[7],
  pageLeaf.options[8],
  pageLeaf.options[9].extend({ text: contentText.optional() }),
] as const;
const image = z.strictObject({
  kind: z.literal("Image"),
  src: z.string().min(1).max(8192),
  alt: contentText,
  ratio: z.number().finite().positive().optional(),
  caption: contentText.optional(),
});
const boundLeaf = z.union([...sharedLeaves, table, detail, pageLeaf.options[5], pageLeaf.options[6], cards, image, choice, draft]);
type BlockSection = {
  kind: "Section";
  title: string;
  description?: string;
  icon?: string;
  color?: z.infer<typeof blockColor>;
  children: Block[];
};
type BlockInputSection = {
  kind: "Section";
  title: string;
  description?: string;
  icon?: string;
  color?: z.infer<typeof blockColor>;
  children: BlockInput[];
};
export type Block = z.infer<typeof boundLeaf> | BlockSection;
const section = <T extends z.ZodType>(node: T) =>
  z.strictObject({
    kind: z.literal("Section"),
    title: label,
    description: label.optional(),
    icon: blockIcon.optional(),
    color: blockColor.optional(),
    children: z.array(node).max(BLOCK_LIMITS.nodes),
  });
export const BlockSchema: z.ZodType<Block> = z.lazy(() => z.union([boundLeaf, section(BlockSchema)]));

/** Chart bindings occupy only the chart's declared value/list positions; bind.ts checks those positions. */
type Bindable<T> = T extends readonly (infer V)[]
  ? Bindable<V>[] | BlockBinding
  : T extends object
    ? { [K in keyof T]: Bindable<T[K]> }
    : T;
export type BindableChartDescription = Bindable<CodeChartDescription>;
const inputLeaf = z.union([
  ...sharedLeaves,
  table.extend({ rows: z.union([table.shape.rows, BlockBindingSchema]) }),
  detail.extend({ items: z.union([detail.shape.items, BlockBindingSchema]) }),
  pageLeaf.options[6].extend({ items: z.union([pageLeaf.options[6].shape.items, BlockBindingSchema]) }),
  cards.extend({ items: z.union([collection, BlockBindingSchema]) }),
  image,
  choice.extend({ options: z.union([choice.shape.options, BlockBindingSchema]) }),
  draft,
  pageLeaf.options[5].extend({
    description: z
      .custom<BindableChartDescription>((value) => value !== null && typeof value === "object" && !Array.isArray(value))
      .optional(),
  }),
]);

export type BlockInput = z.infer<typeof inputLeaf> | BlockInputSection;
export const BlockInputSchema: z.ZodType<BlockInput> = z.lazy(() => z.union([inputLeaf, section(BlockInputSchema)]));
export const BlockViewSchema = z.strictObject({ version: z.literal(1), blocks: z.array(BlockInputSchema).max(BLOCK_LIMITS.nodes) });
export const BoundBlockViewSchema = z.strictObject({ version: z.literal(1), blocks: z.array(BlockSchema).max(BLOCK_LIMITS.nodes) });
export type BlockView = z.infer<typeof BlockViewSchema>;
export type BoundBlockView = z.infer<typeof BoundBlockViewSchema>;
export type CodePageField = z.infer<typeof CodePageFieldSchema>;
