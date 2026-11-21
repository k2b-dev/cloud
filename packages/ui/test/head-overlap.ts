/**
 * Overlap tests for browser tests, run in the page: pass a function to `page.evaluate`, so it closes over nothing.
 *
 * - `layoutProblems` is the general K15 self-check of Cloud flach (the mockups' `?check=1`): siblings in a flex or
 *   grid box that overlap, content that spills out of its box, text that is cut without an ellipsis or a fade, and a
 *   page that scrolls sideways. Call it once per width in its own test (a browser test has 5 s):
 *
 *   ```ts
 *   import { layoutProblems } from "../../../ui/test/head-overlap"; // from an app: the relative path to packages/ui/test
 *
 *   for (const width of [390, 768, 1440, 1920])
 *     test(`${width} px: nothing overlaps, spills, or is cut`, async () => {
 *       await page.setViewportSize({ width, height: 900 });
 *       expect((await page.evaluate(layoutProblems, { root: "#app" })).problems).toEqual([]);
 *     });
 *   ```
 *
 *   Limits, as in the mockups: it does not see what runs out of the bottom of a scroll area, nor what a floating layer
 *   covers; a review checks those. A box whose children overlap on purpose (an avatar stack) is listed in `ignore`.
 * - `headOverlaps` checks the controls of a workspace head row in detail.
 */

export type LayoutProblemOptions = {
  /** The element to check; the whole document by default. */
  root?: string;
  /** Boxes whose children overlap or clip on purpose; they and everything inside them are skipped. */
  ignore?: string;
  /**
   * How far content may reach past its box before it counts, in px. 7 as in the mockups: an icon button at a column
   * edge is pulled out by 6 px on purpose (K5).
   */
  slack?: number;
};

export type LayoutProblems = {
  overlap: string[];
  spill: string[];
  cut: string[];
  sideways: boolean;
  /** Every problem as one readable line; empty when the page is clean. */
  problems: string[];
};

export function layoutProblems(options: LayoutProblemOptions = {}): LayoutProblems {
  const root = options.root ? document.querySelector(options.root) : document.body;
  if (!root) return { overlap: [], spill: [], cut: [], sideways: false, problems: [`no element matches ${options.root}`] };
  const ignore = options.ignore ?? ".k2b-avatar-stack, [data-layout-check='skip']";
  const slack = options.slack ?? 7;
  const seen = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && element.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  };
  // A box that sticks or floats lies above the flow on purpose.
  const inFlow = (element: Element) => !["absolute", "fixed", "sticky"].includes(getComputedStyle(element).position);
  // `display: contents` boxes draw nothing; their children take part in the layout.
  const drawn = (element: Element): Element[] =>
    getComputedStyle(element).display === "contents" ? Array.from(element.children).flatMap(drawn) : [element];
  const name = (element: Element) => {
    const probe = element.getAttribute("data-probe");
    if (probe) return `[data-probe="${probe}"]`;
    const classes = typeof element.className === "string" ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : [];
    const text = element.textContent?.trim().replace(/\s+/g, " ").slice(0, 24);
    return `${element.tagName.toLowerCase()}${classes.map((c) => `.${c}`).join("")}${text ? ` "${text}"` : ""}`;
  };
  const found = { overlap: [] as string[], spill: [] as string[], cut: [] as string[] };
  for (const box of [root, ...Array.from(root.querySelectorAll("*"))]) {
    if (!(box instanceof HTMLElement) || !seen(box) || box.closest(ignore)) continue;
    const style = getComputedStyle(box);
    if (/flex|grid/.test(style.display)) {
      const children = Array.from(box.children)
        .flatMap(drawn)
        .filter((child) => seen(child) && inFlow(child));
      for (const [index, a] of children.entries())
        for (const b of children.slice(index + 1)) {
          const x = a.getBoundingClientRect();
          const y = b.getBoundingClientRect();
          const width = Math.min(x.right, y.right) - Math.max(x.left, y.left);
          const height = Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top);
          if (width > 1.5 && height > 1.5)
            found.overlap.push(`${name(b)} overlaps ${name(a)} by ${Math.round(width)}x${Math.round(height)}`);
        }
    }
    if (box.clientWidth > 0 && box.scrollWidth > box.clientWidth + slack) {
      const masked = style.maskImage !== "none" && style.maskImage !== "";
      // A scroller in either direction lets a person reach its content; it is not cut.
      const scrolls = [style.overflowX, style.overflowY].some((overflow) => overflow === "auto" || overflow === "scroll");
      if (style.overflowX === "visible") found.spill.push(`${name(box)} spills ${box.scrollWidth - box.clientWidth} px out of its box`);
      else if (!scrolls && style.textOverflow !== "ellipsis" && !masked)
        found.cut.push(`${name(box)} is cut by ${box.scrollWidth - box.clientWidth} px without an ellipsis or a fade`);
    }
  }
  const page = document.scrollingElement ?? document.documentElement;
  const sideways = page.scrollWidth > window.innerWidth + 1;
  const problems = [
    ...found.overlap,
    ...found.spill,
    ...found.cut,
    ...(sideways ? [`the page scrolls sideways (${page.scrollWidth} px)`] : []),
  ];
  return { ...found, sideways, problems };
}

/**
 * Finds head row controls that draw over each other or outside the head, and a current view that is not shown whole.
 * Runs in the page: pass it to `page.evaluate`, so it closes over nothing. A control counts with the part of it that
 * a person sees: its box cut by every scrolling or clipping ancestor, so a tab scrolled out of the strip is no control
 * there. The Details button belongs to the head's first line although it is a sibling of the detail.
 */
export function headOverlaps(root: ParentNode = document, tolerance = 0.5) {
  const head = root.querySelector<HTMLElement>(".k2b-app-workspace__head[data-row]");
  if (!head || head.getClientRects().length === 0) return { head: null, controls: [], problems: [] as string[] };
  const workspace = head.closest(".k2b-app-workspace") ?? head.parentElement!;
  const selectors: [string, string][] = [
    ["title", ":scope > .k2b-app-workspace__head-lead > .k2b-page-title"],
    ["toggle", ".k2b-app-workspace__head-toggle"],
    ["tab", ".k2b-view-tabs__item > a"],
    ["more", ".k2b-view-tabs__more-trigger"],
    ["chip", ".k2b-filter-chip"],
    ["reset", ".k2b-app-workspace__head-reset"],
    ["count", ".k2b-app-workspace__head-count > span"],
    ["action", ".k2b-app-workspace__head-actions > *"],
  ];
  type Box = { left: number; top: number; right: number; bottom: number };
  const seen = new Set<Element>();
  const candidates: { name: string; element: HTMLElement }[] = [];
  // Island wrappers and other `display: contents` boxes draw nothing; their children are the controls.
  const drawn = (element: HTMLElement): HTMLElement[] =>
    getComputedStyle(element).display === "contents"
      ? Array.from(element.children).flatMap((child) => (child instanceof HTMLElement ? drawn(child) : []))
      : [element];
  for (const [kind, selector] of selectors)
    for (const element of Array.from(head.querySelectorAll<HTMLElement>(selector)).flatMap(drawn)) {
      if (seen.has(element)) continue;
      seen.add(element);
      const label = element.getAttribute("aria-label") ?? element.textContent?.trim().replace(/\s+/g, " ").slice(0, 24) ?? "";
      candidates.push({ name: `${element.matches("[data-workspace-primary]") ? "primary" : kind} "${label}"`, element });
    }
  for (const element of workspace.querySelectorAll<HTMLElement>(":scope > .k2b-app-workspace__content [data-app-workspace-detail-toggle]"))
    if (element.closest(".k2b-app-workspace") === workspace) candidates.push({ name: "details", element });
  const shown = (element: HTMLElement): Box | null => {
    if (!element.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return null;
    const rect = element.getBoundingClientRect();
    // Visually hidden parts (a 1 px status line) are no controls a person sees.
    if (rect.width <= 1 || rect.height <= 1) return null;
    const box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    const position = getComputedStyle(element).position;
    // Overflow between an out-of-flow control and its containing block does
    // not clip it. Details is positioned in the workspace grid, above Content.
    let overflowCanClip = position !== "absolute" && position !== "fixed";
    const containingBlock = element.offsetParent;
    for (let ancestor = element.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
      if (ancestor === containingBlock) overflowCanClip = true;
      const style = getComputedStyle(ancestor);
      const clip = ancestor.getBoundingClientRect();
      const clipped = style.clipPath !== "none" && style.clipPath !== "";
      if ((overflowCanClip && style.overflowX !== "visible") || clipped) {
        box.left = Math.max(box.left, clip.left);
        box.right = Math.min(box.right, clip.right);
      }
      if ((overflowCanClip && style.overflowY !== "visible") || clipped) {
        box.top = Math.max(box.top, clip.top);
        box.bottom = Math.min(box.bottom, clip.bottom);
      }
    }
    // A count wraps its text below its one-line box when it does not fit: then it is gone, not cut.
    return box.right - box.left > 1 && box.bottom - box.top > 1 ? box : null;
  };
  const headBox = head.getBoundingClientRect();
  const controls = candidates.flatMap(({ name, element }) => {
    const box = shown(element);
    return box ? [{ name, box }] : [];
  });
  const problems: string[] = [];
  const round = (value: number) => Math.round(value * 10) / 10;
  // Only tabs, filter chips and the quiet count are intentional scrollers.
  // Every painted action and navigation control must remain wholly visible.
  for (const { name, element } of candidates) {
    if (!/^(primary|action|toggle|details)\b/.test(name) || !element.checkVisibility({ visibilityProperty: true, opacityProperty: true }))
      continue;
    const whole = element.getBoundingClientRect();
    if (whole.width <= 1 || whole.height <= 1) continue;
    const clipped = shown(element);
    if (!clipped || clipped.right - clipped.left < whole.width - tolerance || clipped.bottom - clipped.top < whole.height - tolerance)
      problems.push(`${name} is clipped`);
  }
  const current = head.querySelector<HTMLElement>('.k2b-view-tabs__item > a[aria-current="page"]');
  if (current) {
    const whole = current.getBoundingClientRect();
    const box = shown(current);
    if (!box || box.right - box.left < whole.width - tolerance) problems.push("the current view is not shown whole");
  }
  for (const { name, box } of controls)
    if (
      box.left < headBox.left - tolerance ||
      box.right > headBox.right + tolerance ||
      box.top < headBox.top - tolerance ||
      box.bottom > headBox.bottom + tolerance
    )
      problems.push(
        `${name} leaves the head (x ${round(box.left)}..${round(box.right)} of ${round(headBox.left)}..${round(headBox.right)}; y ${round(box.top)}..${round(box.bottom)} of ${round(headBox.top)}..${round(headBox.bottom)})`,
      );
  for (const [index, a] of controls.entries())
    for (const b of controls.slice(index + 1)) {
      const width = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
      const height = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
      if (width > tolerance && height > tolerance) problems.push(`${a.name} overlaps ${b.name} by ${round(width)}x${round(height)}`);
    }
  return { head: { width: headBox.width, height: headBox.height }, controls: controls.map((control) => control.name), problems };
}
