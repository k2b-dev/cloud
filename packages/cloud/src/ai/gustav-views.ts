import { bindView } from "../blocks/bind";
import type { BlockView } from "../blocks/schema";
import { validateBlocks } from "../blocks/validate";
import { cardToolBlocks, chartToolBlocks } from "./gustav-view-blocks";

/**
 * Gustav's own visuals as the same blocks an app's result uses, so a chart or key figure Gustav shows looks like one an
 * app returns: under Cloud's head, a chart as an island, key figures flat. The translation is `gustav-view-blocks.ts`;
 * here Cloud checks it like an app's view. Input the blocks cannot hold, such as more series than a block allows,
 * returns `null` and keeps the tool's own drawing.
 */
const checked = (view: BlockView | null): BlockView | null => {
  if (!view) return null;
  try {
    validateBlocks(bindView(view, {}).blocks, "result", { appId: "core", appPrefixes: [] });
    return view;
  } catch {
    return null;
  }
};

export const chartToolView = (args: unknown): BlockView | null => checked(chartToolBlocks(args));
export const cardToolView = (args: unknown): BlockView | null => checked(cardToolBlocks(args));

/** The stored result of a chart or card call: the model reads `displayed`; people see the view. */
const withView = (view: BlockView | null): { displayed: true; view?: BlockView; data?: Record<string, never> } =>
  view ? { displayed: true, view, data: {} } : { displayed: true };
export const chartToolResult = (args: unknown) => withView(chartToolView(args));
export const cardToolResult = (args: unknown) => withView(cardToolView(args));
