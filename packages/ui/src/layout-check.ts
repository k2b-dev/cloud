/**
 * The layout self-check of Cloud flach (K15), the mockups' `?check=1` as a function for browser tests. It finds
 * siblings in a flex or grid box that overlap, content that spills out of its box, text that is cut without an
 * ellipsis or a fade, and a page that scrolls sideways.
 *
 * It runs in the page: pass it to Playwright's `page.evaluate`, so it closes over nothing and needs no other module.
 * Check each width in its own test:
 *
 * ```ts
 * import { layoutProblems } from "@k2b/ui/layout-check";
 *
 * for (const width of [390, 768, 1440, 1920])
 *   test(`${width} px: nothing overlaps, spills, or is cut`, async () => {
 *     await page.setViewportSize({ width, height: 900 });
 *     expect((await page.evaluate(layoutProblems, { root: "#app" })).problems).toEqual([]);
 *   });
 * ```
 *
 * Limits, as in the mockups: it does not see what runs out of the bottom of a scroll area, nor what a floating layer
 * covers; a review checks those. A box whose children overlap on purpose (an avatar stack) is listed in `ignore`, or
 * carries `data-layout-check="skip"`.
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
