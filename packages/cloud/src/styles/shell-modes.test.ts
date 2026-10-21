import { expect, test } from "bun:test";
import { resolve } from "node:path";

// The shell modes switch at 768 and 1024 px. A `max-width: 1023px` beside a
// `min-width: 1024px` leaves fractional widths, such as a zoomed window,
// in neither mode, so the shell falls back to its base rules there. Each
// width query states only `min-width`, negated with `not all and` for the
// range below it, so neighbouring modes are exact opposites.
test("the shell modes cover every width exactly once", async () => {
  const css = await Bun.file(resolve(import.meta.dir, "global.css")).text();
  const queries = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/@media([^{]*)\{/g)].map(([, query]) => query!.trim());
  const widthQueries = queries.filter((query) => query.includes("width"));

  expect(widthQueries).toEqual([
    "not all and (min-width: 768px)",
    // The overview card hands its paint to the workspace only while both
    // Cloud's px phone mode and the workspace's rem phone mode apply.
    "not all and (min-width: 768px)",
    "not all and (min-width: 48rem)",
    // The phone bar switches with Tailwind's `md`, as the header and the rail
    // do, so it stays in step with them under a larger default font size.
    "not all and (min-width: 48rem)",
    "(min-width: 768px)",
    "(min-width: 768px)",
    "not all and (min-width: 1024px)",
    "(min-width: 1024px)",
    // Focus state follows the same boundaries; only its reveal strip needs a coarse pointer.
    "(min-width: 768px)",
    "(min-width: 768px) and (pointer: coarse)",
    "(min-width: 768px)",
    "not all and (min-width: 1024px)",
    "(min-width: 1024px)",
  ]);
});

test("overview card paint requires both phone modes, rather than either one", async () => {
  const css = await Bun.file(resolve(import.meta.dir, "global.css")).text();
  // Keep the conditions nested (an intersection). Parallel queries or a
  // comma-separated union would also move card paint on tablet widths when
  // the browser's default font size changes the rem boundary.
  expect(css).toMatch(
    /@media not all and \(min-width: 768px\)\s*\{\s*@media not all and \(min-width: 48rem\)\s*\{\s*\.cloud-app-canvas\[data-layout-authenticated\] \.layout-content-main:has\(/,
  );
});
