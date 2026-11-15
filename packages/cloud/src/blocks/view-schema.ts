import type { z } from "zod";
import { bindView } from "./bind";
import { assertBlockData } from "./data";
import { type BlockView, BlockViewSchema, type BoundBlockView, BoundBlockViewSchema } from "./schema";

/**
 * The view checks of the shared capability contracts. Servers check every view strictly: shape, limits, bindings and
 * data. Browsers (`./view-schema.browser.ts`) read views a server already checked and keep only the envelope check, so
 * no island carries the block schemas.
 */

export const ViewSchema: z.ZodType<BlockView> = BlockViewSchema;
export const BoundViewSchema: z.ZodType<BoundBlockView> = BoundBlockViewSchema;
/** Throws when a result's view does not bind to its data. */
export const checkViewBinding = (view: unknown, data: unknown): void => {
  bindView(view, data);
};
/** Throws when a value is not plain JSON data within the result budget. */
export const assertViewData = (value: unknown): void => assertBlockData(value);
/** Binds a view to its data with every check; see `bindView`. */
export const bindCheckedView: (view: unknown, data: unknown, options?: { maxBytes?: number }) => BoundBlockView = bindView;
