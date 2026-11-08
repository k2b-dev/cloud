import { z } from "zod";
import { boundBlocks, isBlockBinding } from "./bound";
import { blockDataAtPath } from "./path";
import type { Block, BlockInput, BlockView, BoundBlockView } from "./schema";

/**
 * The browser side of `./view-schema.ts`: a browser renders only views Cloud already checked on the server, so it
 * checks the envelope and leaves shape, limits and data rules to the server. A browser check is never a trust boundary.
 */

const envelope = (value: unknown): value is { version: 1; blocks: (Block | BlockInput)[] } =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Reflect.get(value, "version") === 1 &&
  Array.isArray(Reflect.get(value, "blocks"));

export const ViewSchema: z.ZodType<BlockView> = z.custom<BlockView>(envelope, "Invalid block view");
export const BoundViewSchema: z.ZodType<BoundBlockView> = z.custom<BoundBlockView>(envelope, "Invalid block view");
export const checkViewBinding = (_view: unknown, _data: unknown): void => {};
export const assertViewData = (_value: unknown): void => {};

/** The list positions a binding may stand in; the server checked every other rule when it accepted the view. */
const LISTS = { Table: "rows", Cards: "items", Choice: "options", Stats: "items", Detail: "items" } as const;
const CHART_LISTS = new Set([
  "data",
  "series",
  "x",
  "rows",
  "values",
  "steps",
  "sparkline",
  "groups",
  "axes",
  "references",
  "thresholds",
  "bins",
]);

/**
 * Resolves the data paths of a view a server checked, such as an Action's review before it is approved. The paths
 * resolve over own data properties only; a path that does not lead to a list refuses the view.
 */
export const bindCheckedView = (view: unknown, data: unknown, _options?: { maxBytes?: number }): BoundBlockView => {
  if (!envelope(view)) throw new Error("blocks_binding");
  const list = (value: unknown): unknown => {
    if (!isBlockBinding(value)) return value;
    const resolved = blockDataAtPath(data, Reflect.get(value as object, "from") as string[]);
    if (!Array.isArray(resolved)) throw new Error("blocks_binding");
    return resolved;
  };
  const chart = (value: unknown, key = ""): unknown => {
    if (Array.isArray(value)) return value.map((child) => chart(child));
    if (value === null || typeof value !== "object") return value;
    if (isBlockBinding(value)) {
      if (!CHART_LISTS.has(key)) throw new Error("blocks_binding_position");
      return list(value);
    }
    return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, chart(child, name)]));
  };
  const bind = (node: Block | BlockInput): unknown => {
    if (node.kind === "Section") return { ...node, children: node.children.map(bind) };
    if (node.kind === "Chart" && node.description !== undefined) return { ...node, description: chart(node.description) };
    const key = LISTS[node.kind as keyof typeof LISTS];
    return key ? { ...node, [key]: list(Reflect.get(node, key)) } : node;
  };
  const blocks = boundBlocks(view.blocks.map(bind) as (Block | BlockInput)[]);
  if (!blocks) throw new Error("blocks_binding");
  return { version: 1, blocks };
};
