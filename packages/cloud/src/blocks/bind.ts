import { CAPABILITY_MAX_RESULT_BYTES } from "../contracts/capability-limits";
import { assertBlockData, assertNoDroppedBlockKeys, unsafeBlockKey } from "./data";
import { BLOCK_LIMITS, BlockBindingSchema, BlockViewSchema, type BoundBlockView, BoundBlockViewSchema } from "./schema";

/** Own data descriptors only. The public capability helper uses this same path resolver. */
export function blockDataAtPath(data: unknown, path: readonly string[]): unknown {
  if (path.length > 16 || path.some((key) => typeof key !== "string" || key.length > 500 || unsafeBlockKey(key)))
    throw new Error("blocks_path");
  let value = data;
  for (const segment of path) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, segment)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, segment);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error("blocks_data_only");
    value = descriptor.value;
  }
  return value;
}

/** Bind only declared list positions. Card, option and column mappings stay relative to each resolved item. */
export function bindView(view: unknown, data: unknown, options: { maxBytes?: number } = {}): BoundBlockView {
  const maxBytes = options.maxBytes ?? CAPABILITY_MAX_RESULT_BYTES;
  assertBlockData(view, maxBytes);
  assertBlockData(data, maxBytes);
  const input = BlockViewSchema.parse(view);
  let remaining = maxBytes;
  const copy = (value: unknown): unknown => {
    // Charge before copying each expansion, including repeated references to the same data.
    assertBlockData(value, remaining);
    remaining -= new TextEncoder().encode(JSON.stringify(value)).byteLength;
    return structuredClone(value);
  };
  const list = (value: unknown, limit: number): unknown => {
    const binding = BlockBindingSchema.safeParse(value);
    if (!binding.success) return copy(value);
    const resolved = blockDataAtPath(data, binding.data.from);
    if (!Array.isArray(resolved) || resolved.length > limit) throw new Error("blocks_binding");
    return copy(resolved);
  };
  // These are chart value/list slots in the portable chart schema, not arbitrary {from} objects.
  const chartLists = new Set([
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
  const chart = (value: unknown, key = "", depth = 0): unknown => {
    if (depth > BLOCK_LIMITS.depth * 3) throw new Error("blocks_limit");
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      if (Object.hasOwn(value, "from")) {
        if (!chartLists.has(key)) throw new Error("blocks_binding_position");
        return list(value, key === "series" || key === "references" || key === "thresholds" || key === "groups" ? 8 : BLOCK_LIMITS.rows);
      }
      return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, chart(child, name, depth + 1)]));
    }
    if (Array.isArray(value)) return value.map((child) => chart(child, "", depth + 1));
    return value;
  };
  let nodes = 0;
  const bind = (node: (typeof input.blocks)[number], depth: number): unknown => {
    if (++nodes > BLOCK_LIMITS.nodes || depth > BLOCK_LIMITS.depth) throw new Error("blocks_limit");
    if (node.kind === "Section") return { ...node, children: node.children.map((child) => bind(child, depth + 1)) };
    if (node.kind === "Table") return { ...node, rows: list(node.rows, BLOCK_LIMITS.rows) };
    if (node.kind === "Cards") return { ...node, items: list(node.items, BLOCK_LIMITS.rows) };
    if (node.kind === "Choice") return { ...node, options: list(node.options, BLOCK_LIMITS.rows) };
    if (node.kind === "Stats") return { ...node, items: list(node.items, BLOCK_LIMITS.stats) };
    if (node.kind === "Detail") return { ...node, items: list(node.items, BLOCK_LIMITS.details) };
    if (node.kind === "Chart" && node.description !== undefined) return { ...node, description: chart(node.description) };
    return node;
  };
  const bound = { version: 1, blocks: input.blocks.map((node) => bind(node, 1)) };
  assertBlockData(bound, maxBytes);
  const parsed = BoundBlockViewSchema.parse(bound);
  assertNoDroppedBlockKeys(bound, parsed);
  return parsed;
}
