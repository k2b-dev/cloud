import type { Block, BlockInput } from "./schema";

/**
 * Small helpers for views Cloud already bound and checked, light enough for the browser: no schemas and no binding.
 * Servers bind a view once when they read it (`bindView`); a browser only tells a bound view from a raw one.
 */

/** A `{ from: [...] }` data path in place of a list. */
export const isBlockBinding = (value: unknown): boolean =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === 1 &&
  Array.isArray(Reflect.get(value, "from"));

const hasBinding = (value: unknown, depth = 0): boolean => {
  if (depth > 40 || value === null || typeof value !== "object") return false;
  if (isBlockBinding(value)) return true;
  return Object.values(value).some((entry) => hasBinding(entry, depth + 1));
};

const isBoundBlock = (block: Block | BlockInput): block is Block => !hasBinding(block);

/** The blocks of a view Cloud bound, or nothing when a value still points into data. */
export const boundBlocks = (blocks: readonly (Block | BlockInput)[]): Block[] | undefined => {
  const bound = blocks.filter(isBoundBlock);
  return bound.length === blocks.length ? bound : undefined;
};

/** The one draft of a view, also inside a section. */
export const findDraft = (blocks: readonly Block[] | undefined): Extract<Block, { kind: "Draft" }> | undefined => {
  for (const block of blocks ?? []) {
    if (block.kind === "Draft") return block;
    if (block.kind === "Section") {
      const draft = findDraft(block.children);
      if (draft) return draft;
    }
  }
};
