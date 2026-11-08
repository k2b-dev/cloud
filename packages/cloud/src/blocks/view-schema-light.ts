import { z } from "zod";
import { boundBlocks } from "./bound";
import type { Block, BlockInput, BlockView, BoundBlockView } from "./schema";

/**
 * The browser side of `./view-schema.ts`: a browser renders only views Cloud already checked on the server, so it
 * checks the envelope and leaves shape, limits and bindings to the server. A browser check is never a trust boundary.
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
/** A browser binds nothing: it accepts a view without data paths as it is and refuses one that still has them. */
export const bindCheckedView = (view: unknown, _data: unknown, _options?: { maxBytes?: number }): BoundBlockView => {
  const blocks = envelope(view) ? boundBlocks(view.blocks) : undefined;
  if (!blocks) throw new Error("blocks_binding");
  return { version: 1, blocks };
};
