/**
 * `@k2b/ui/v2/testing`: check a v2 screen in a Playwright test the same way @k2b/ui checks its own primitives.
 *
 * - `measureV2Layout(page)`: edges, double lines, type roles and grips as numbers; `problems` is empty when the page
 *   keeps the v2 rules.
 * - `describeV2Page(page)`: the text outline of `describeV2` from a laid-out page, with hidden parts and dropped
 *   columns at the page's width.
 * - `settled(page)`: waits for fonts, layout and finite animations before anything is read.
 *
 * Needs Playwright in the consumer (an optional peer dependency); nothing here is part of the main export.
 */
import type { Page } from "playwright";
import { describeV2 } from "../describe";

export { measureV2Layout, type V2GripMeasure, type V2Layout, type V2LayoutOptions } from "./measure-v2-layout";
export { settled } from "./settled";

/** The `describeV2` outline of a laid-out page, from `root` (the whole body by default). */
export const describeV2Page = async (page: Page, root = "body"): Promise<string> => {
  const outline = (await page.evaluate(
    `(() => { const root = document.querySelector(${JSON.stringify(root)}); return root ? (${describeV2})(root, { layout: true }) : null; })()`,
  )) as string | null;
  if (outline === null) throw new Error(`describeV2Page: no element matches ${root}`);
  return outline;
};
