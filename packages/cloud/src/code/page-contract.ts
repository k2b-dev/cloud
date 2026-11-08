import { chartNumberFormatSchema, chartSchema } from "@k2b/editor/chart-schema";
import { z } from "zod";
import { codeOwnPath } from "../contracts/code-routes";
import { CODE_REQUEST_LIMITS } from "./request-limits";

/** Initial SSR rendering budget. The tree takes at most half of the response envelope. */
export const CODE_PAGE_LIMITS = Object.freeze({
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
const text = z.string().max(CODE_PAGE_LIMITS.bytes);
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
      .max(CODE_PAGE_LIMITS.rows)
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
  maxValues: CODE_PAGE_LIMITS.rows,
  maxMarks: CODE_PAGE_LIMITS.rows * 8,
});
export type CodeChartDescription = z.infer<typeof CodeChartDescriptionSchema>;
/** A Tabler icon class such as `ti ti-package`; a name only, never markup. */
const icon = z.string().regex(/^ti ti-[a-z0-9]+(?:-[a-z0-9]+)*$/);
/** Colours with meaning in @k2b/ui; the AI colour is not among them. */
const color = z.enum(["zinc", "blue", "emerald", "amber", "red"]);
/** A panel's share of the six grid columns; narrow pages give every panel more room, phones the whole row. */
const width = z.enum(["third", "half", "twoThirds", "full"]).optional();
/** A panel's content height: small 200 px, medium 300 px, large 400 px; a row of panels lines up when they share it. */
const height = z.enum(["sm", "md", "lg"]).optional();
/** Titles and labels as the shared description panels hold them. */
const panelTitle = z.string().min(1).max(160).regex(/\S/);
const shortLabel = z.string().min(1).max(80).regex(/\S/);
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
  label: shortLabel,
  value: z.union([z.number().finite(), shortLabel, z.null()]),
  format: numberFormat.optional(),
  icon: icon.optional(),
  /** The colour of `icon`'s chip. */
  tone: color.optional(),
  /** Change since the comparison: a share (0.082 is 8.2 %) or, with `unit: "points"`, percentage points. */
  delta: z
    .strictObject({ value: z.number().finite(), unit: z.literal("points").optional(), better: z.enum(["up", "down"]).optional() })
    .optional(),
  compare: z.strictObject({ label: shortLabel, value: z.number().finite() }).optional(),
  trend: z.array(z.number().finite()).max(CODE_PAGE_LIMITS.trend).optional(),
});
const leaf = z.discriminatedUnion("kind", [
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
          label: shortLabel,
          /** What the column holds; it decides alignment, text and sorting. A status shows a badge from `states`. */
          type: z.enum(["text", "number", "date", "status", "bar", "amount", "flow", "delta"]).optional(),
          format: tableFormat.optional(),
          states: z
            .record(
              fieldName,
              z.strictObject({ label: shortLabel, tone: z.enum(["info", "ok", "warning", "error", "degraded", "running", "neutral"]) }),
            )
            .optional(),
          /** Columns that give way first on a narrow screen: 3 below 560 px, then 2 below 420 px. */
          priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
        }),
      )
      .min(1)
      .max(CODE_PAGE_LIMITS.columns),
    rows: z.array(z.record(z.string(), scalar)).max(CODE_PAGE_LIMITS.rows),
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
    fields: z.array(CodePageFieldSchema).min(1).max(CODE_PAGE_LIMITS.fields),
    submit: label,
    width,
  }),
  z.strictObject({
    kind: z.literal("Detail"),
    title: panelTitle,
    items: z
      .array(z.strictObject({ label: shortLabel, value: scalar, format: numberFormat.optional() }))
      .min(1)
      .max(CODE_PAGE_LIMITS.details),
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
  z.strictObject({ kind: z.literal("Stats"), items: z.array(stat).min(1).max(CODE_PAGE_LIMITS.stats) }),
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
  color?: z.infer<typeof color>;
  children: CodePageNode[];
};
export type CodePageNode = z.infer<typeof leaf> | CodePageSection;
export const CodePageNodeSchema: z.ZodType<CodePageNode> = z.lazy(() =>
  z.union([
    leaf,
    z.strictObject({
      kind: z.literal("Section"),
      title: label,
      description: label.optional(),
      icon: icon.optional(),
      color: color.optional(),
      children: z.array(CodePageNodeSchema).max(CODE_PAGE_LIMITS.nodes),
    }),
  ]),
);
/** An application event type, `<app>.<event>`, as the event catalog names it. */
const eventType = z
  .string()
  .max(200)
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9_-]*)+$/);
export const CodePageTreeSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("Page"),
  title: label,
  /** A short line above the title that places the page, such as the source or the team. */
  eyebrow: shortLabel.optional(),
  /** Quiet line below the title, such as what the page covers. */
  subtitle: label.optional(),
  /** When the shown data was read, as an ISO date-time; Cloud shows it in the reader's language and zone. */
  asOf: z.iso.datetime({ offset: true }).optional(),
  icon: icon.optional(),
  color: color.optional(),
  /** Event types after which Cloud loads this page again for its viewer. */
  follow: z
    .array(eventType)
    .max(CODE_PAGE_LIMITS.follow)
    .refine((types) => new Set(types).size === types.length, "Event types are unique")
    .optional(),
  children: z.array(CodePageNodeSchema).max(CODE_PAGE_LIMITS.nodes),
});
export type CodePageTree = z.infer<typeof CodePageTreeSchema>;
export type CodePageField = z.infer<typeof CodePageFieldSchema>;

/** Guard before recursive schema parsing or JSON serialization. Never silently omit executable values. */
export function assertCodePageData(value: unknown): void {
  const ancestors = new Set<object>();
  let entries = 0,
    bytes = 0;
  function visit(item: unknown, depth: number): void {
    if (++entries > CODE_PAGE_LIMITS.bytes || depth > CODE_PAGE_LIMITS.depth * 3) throw new Error("code_page_limit");
    if (typeof item === "string") {
      bytes += Buffer.byteLength(item);
      if (bytes > CODE_PAGE_LIMITS.bytes) throw new Error("code_page_limit");
      return;
    }
    if (item === null || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) return;
    if (typeof item !== "object" || ancestors.has(item)) throw new Error("code_page_data_only");
    if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null && !Array.isArray(item))
      throw new Error("code_page_data_only");
    ancestors.add(item);
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === "length") continue;
      if (typeof key !== "string") throw new Error("code_page_data_only");
      const prop = Object.getOwnPropertyDescriptor(item, key)!;
      if (!prop.enumerable || !Object.hasOwn(prop, "value")) throw new Error("code_page_data_only");
      bytes += Buffer.byteLength(key);
      if (bytes > CODE_PAGE_LIMITS.bytes) throw new Error("code_page_limit");
      visit(prop.value, depth + 1);
    }
    ancestors.delete(item);
  }
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > CODE_PAGE_LIMITS.bytes) throw new Error("code_page_limit");
}
/** Reject unknown chart properties as well: portable chart schemas historically strip unknown keys. */
function assertNoDroppedKeys(original: unknown, parsed: unknown): void {
  if (!original || typeof original !== "object") return;
  if (!parsed || typeof parsed !== "object") throw new Error("code_page_unknown_field");
  for (const [key, value] of Object.entries(original)) {
    if (!Object.hasOwn(parsed, key)) throw new Error("code_page_unknown_field");
    assertNoDroppedKeys(value, Reflect.get(parsed, key));
  }
}
/** Core calls this for every response immediately before rendering. Links resolve only inside this Code. */
export function validateCodePage(value: unknown, codeId: string): CodePageTree {
  assertCodePageData(value);
  const tree = CodePageTreeSchema.parse(value);
  assertNoDroppedKeys(value, tree);
  let nodes = 0;
  function check(node: CodePageNode, depth: number): void {
    if (++nodes > CODE_PAGE_LIMITS.nodes || depth > CODE_PAGE_LIMITS.depth) throw new Error("code_page_limit");
    if (node.kind === "Section") node.children.forEach((child) => check(child, depth + 1));
    if (node.kind === "Link") codeOwnPath(codeId, node.href);
    if (node.kind === "Form" || node.kind === "Button" || node.kind === "Action") codeOwnPath(codeId, node.action);
    if (node.kind === "Chart" && (node.description ? node.title !== undefined : node.title === undefined || node.empty === undefined))
      throw new Error("code_page_chart");
    if (node.kind === "Form" && new Set(node.fields.map((field) => field.name)).size !== node.fields.length)
      throw new Error("code_page_duplicate_field");
    if (node.kind === "Table") {
      const columns = new Set(node.columns.map((column) => column.key));
      if (columns.size !== node.columns.length || node.rows.some((row) => Object.keys(row).some((key) => !columns.has(key))))
        throw new Error("code_page_table_columns");
    }
  }
  tree.children.forEach((node) => check(node, 1));
  return tree;
}
