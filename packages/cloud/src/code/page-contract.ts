import { z } from "zod";
import {
  BLOCK_LIMITS as CODE_PAGE_LIMITS,
  type CodePageNode,
  CodePageNodeSchema,
  blockColor as color,
  blockIcon as icon,
  blockShortLabel as shortLabel,
} from "../blocks/schema";
import { codeOwnPath } from "../contracts/code-routes";

export {
  BLOCK_LIMITS as CODE_PAGE_LIMITS,
  type CodeChartDescription,
  CodeChartDescriptionSchema,
  type CodePageField,
  CodePageFieldSchema,
  type CodePageNode,
  CodePageNodeSchema,
} from "../blocks/schema";

const label = z.string().min(1).max(200);
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
