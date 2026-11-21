/**
 * The layout self-check of Cloud flach (K15), the mockups' `?check=1` as a function for browser tests. It finds
 * siblings in a flex or grid box that overlap, content that spills out of its box, text that is cut without an
 * ellipsis or a fade, a double line (two parallel visible borders that touch or lie at most 1 px apart, also across
 * components; "one line, one owner", K2), a scroll container that scrolls sideways, and a page that scrolls sideways.
 *
 * It runs in the page: pass it to Playwright's `page.evaluate`, so it closes over nothing and needs no other module.
 * Check each width in its own test:
 *
 * ```ts
 * import { classicScrollbars, layoutProblems, layoutWidths } from "@k2b/ui/layout-check";
 *
 * const browser = await chromium.launch(classicScrollbars);
 * for (const width of layoutWidths)
 *   test(`${width} px: nothing overlaps, spills, or is cut`, async () => {
 *     await page.setViewportSize({ width, height: 900 });
 *     expect((await page.evaluate(layoutProblems, { root: "#app" })).problems).toEqual([]);
 *   });
 * ```
 *
 * Limits, as in the mockups: it does not see what runs out of the bottom of a scroll area, nor what a floating layer
 * covers; a review checks those. A box whose children overlap on purpose (an avatar stack) is listed in `ignore`, or
 * carries `data-layout-check="skip"`. A touch hit area (an empty, invisible, positioned `::before` or `::after` that
 * reaches past a small control) is no spill and no cut; it needs no exception. A scroller that is meant to scroll
 * sideways says so with `data-layout-check="scroll-x"`; a toolbar (`role="toolbar"`) may scroll below 768 px (K15).
 *
 * Run page tests with classic scrollbars, as on most desktops: headless Chromium hides them unless it is launched with
 * `ignoreDefaultArgs: ["--hide-scrollbars"]`. Only then does a scrollbar take its width, and a column that is a few
 * pixels too wide for the space beside it shows up as a sideways scroller.
 */

/**
 * The widths every page test checks: phone, tablet, a narrow desktop where the detail column is open beside the list,
 * and a wide desktop. 1100 px is where a docked detail column leaves the least room, so a column that is a few pixels
 * too wide or a head that wraps shows there first.
 */
export const layoutWidths = [390, 768, 1100, 1440] as const;

/**
 * Launch options for classic, visible scrollbars, as on most desktops: headless Chromium hides them by default, so a
 * scrollbar never takes its width in a test. Pass them to `chromium.launch`.
 */
export const classicScrollbars: { ignoreDefaultArgs: string[] } = { ignoreDefaultArgs: ["--hide-scrollbars"] };

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
  /** Scroll containers other than the page that scroll sideways without saying they should. */
  scroll: string[];
  double: string[];
  sideways: boolean;
  /** Every problem as one readable line; empty when the page is clean. */
  problems: string[];
};

export function layoutProblems(options: LayoutProblemOptions = {}): LayoutProblems {
  const root = options.root ? document.querySelector(options.root) : document.body;
  if (!root)
    return {
      overlap: [],
      spill: [],
      cut: [],
      scroll: [],
      double: [],
      sideways: false,
      problems: [`no element matches ${options.root}`],
    };
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
  // A touch hit area is an empty, invisible, positioned pseudo-element that reaches past its control on purpose, such as
  // the 44 px tap area of a small button on a coarse pointer. Overflow that only hit areas cause is no spill and no cut.
  // Any other positioned pseudo-element that draws (text, a fill, a border, a shadow) still counts.
  const transparent = (color: string) => color === "transparent" || /^rgba\(.*,\s*0\)$/.test(color);
  const drawsBeyond = (element: Element) =>
    (["::before", "::after"] as const).some((which) => {
      const pseudo = getComputedStyle(element, which);
      if (pseudo.content === "none" || pseudo.content === "normal" || !["absolute", "fixed"].includes(pseudo.position)) return false;
      const drawn =
        pseudo.content !== '""' ||
        !transparent(pseudo.backgroundColor) ||
        pseudo.backgroundImage !== "none" ||
        pseudo.boxShadow !== "none" ||
        ["Top", "Right", "Bottom", "Left"].some(
          (side) => Number.parseFloat(pseudo.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0,
        );
      return drawn;
    });
  const onlyHitAreas = (box: HTMLElement) => {
    const own = box.getBoundingClientRect();
    const left = own.left + box.clientLeft - slack;
    const right = own.left + box.clientLeft + box.clientWidth + slack;
    const range = document.createRange();
    range.selectNodeContents(box);
    const reaches = [range.getBoundingClientRect(), ...Array.from(box.querySelectorAll("*"), (element) => element.getBoundingClientRect())];
    if (reaches.some((rect) => rect.width > 0 && (rect.left < left || rect.right > right))) return false;
    return ![box, ...Array.from(box.querySelectorAll("*"))].some(drawsBeyond);
  };
  // A sideways scroller is a finding unless it says it scrolls on purpose, or it is a toolbar on a phone (K15: only there
  // does a toolbar scroll). A box with only `overflow-y: auto` computes `overflow-x` to auto too, so a scroll area whose
  // content is a few pixels too wide counts here as well.
  const scrollsOnPurpose = (box: HTMLElement) =>
    box.getAttribute("data-layout-check") === "scroll-x" || (box.getAttribute("role") === "toolbar" && window.innerWidth < 768);
  const found = { overlap: [] as string[], spill: [] as string[], cut: [] as string[], scroll: [] as string[] };
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
    // Text for screen readers only (a 1 px clipped box, such as `.k2b-sr-only`) is hidden on purpose, not cut.
    if (box.clientWidth > 1 && box.clientHeight > 1 && box.scrollWidth > box.clientWidth + slack && !onlyHitAreas(box)) {
      const masked = style.maskImage !== "none" && style.maskImage !== "";
      // Only a sideways scroller lets a person reach content that is too wide. `overflow-y: auto` alone already
      // computes `overflow-x` to auto; an explicit `overflow-x: hidden` beside it cuts the content.
      const scrolls = style.overflowX === "auto" || style.overflowX === "scroll";
      if (style.overflowX === "visible") found.spill.push(`${name(box)} spills ${box.scrollWidth - box.clientWidth} px out of its box`);
      else if (scrolls) {
        if (!scrollsOnPurpose(box)) found.scroll.push(`${name(box)} scrolls sideways by ${box.scrollWidth - box.clientWidth} px`);
      } else if (style.textOverflow !== "ellipsis" && !masked)
        found.cut.push(`${name(box)} is cut by ${box.scrollWidth - box.clientWidth} px without an ellipsis or a fade`);
    }
  }
  // Double lines: every visible border side is a band; two parallel bands of different elements that overlap along
  // their length and lie at most 1 px apart across it read as one thick or doubled line. Only `border-*` counts, with
  // a width above 0, a drawing style, and a colour that is not transparent: focus rings and outlines are no borders.
  type Band = { element: Element; side: string; across0: number; across1: number; along0: number; along1: number };
  const bands = { horizontal: [] as Band[], vertical: [] as Band[] };
  for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
    if (!seen(element) || element.closest(ignore)) continue;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    for (const side of ["top", "bottom", "left", "right"] as const) {
      const width = Number.parseFloat(style.getPropertyValue(`border-${side}-width`));
      const line = style.getPropertyValue(`border-${side}-style`);
      const color = style.getPropertyValue(`border-${side}-color`).replace(/\s+/g, "");
      if (!(width > 0) || line === "none" || line === "hidden" || color === "transparent" || /,0\)$|\/0\)$/.test(color)) continue;
      if (side === "top")
        bands.horizontal.push({ element, side, across0: rect.top, across1: rect.top + width, along0: rect.left, along1: rect.right });
      if (side === "bottom")
        bands.horizontal.push({ element, side, across0: rect.bottom - width, across1: rect.bottom, along0: rect.left, along1: rect.right });
      if (side === "left")
        bands.vertical.push({ element, side, across0: rect.left, across1: rect.left + width, along0: rect.top, along1: rect.bottom });
      if (side === "right")
        bands.vertical.push({ element, side, across0: rect.right - width, across1: rect.right, along0: rect.top, along1: rect.bottom });
    }
  }
  // Cells of a collapsed table share one border; the engine reports it on both.
  const collapsedPair = (a: Element, b: Element) => {
    const table = a.closest("table");
    return !!table && table === b.closest("table") && getComputedStyle(table).borderCollapse === "collapse";
  };
  const double: string[] = [];
  for (const list of [bands.horizontal, bands.vertical]) {
    list.sort((a, b) => a.across0 - b.across0);
    for (const [index, a] of list.entries())
      for (const b of list.slice(index + 1)) {
        if (b.across0 - a.across1 > 1) break;
        if (a.element === b.element || collapsedPair(a.element, b.element)) continue;
        const shared = Math.min(a.along1, b.along1) - Math.max(a.along0, b.along0);
        if (shared > 1)
          double.push(
            `double line: ${name(a.element)} ${a.side} and ${name(b.element)} ${b.side} at ${Math.round(a.across0)} px over ${Math.round(shared)} px`,
          );
      }
  }
  const page = document.scrollingElement ?? document.documentElement;
  const sideways = page.scrollWidth > window.innerWidth + 1;
  const problems = [
    ...found.overlap,
    ...found.spill,
    ...found.cut,
    ...found.scroll,
    ...double,
    ...(sideways ? [`the page scrolls sideways (${page.scrollWidth} px)`] : []),
  ];
  return { ...found, double, sideways, problems };
}
