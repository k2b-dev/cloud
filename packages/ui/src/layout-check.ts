/**
 * The layout self-check of Cloud flach (K15), the mockups' `?check=1` as a function for browser tests. It finds
 * siblings in a flex or grid box that overlap, content that spills out of its box, text that is cut without an
 * ellipsis or a fade, a double line (two parallel visible borders that touch or lie at most 1 px apart, also across
 * components; "one line, one owner", K2), a scroll container that scrolls sideways, a line break by scrollbar, and a
 * page that scrolls sideways.
 *
 * A line break by scrollbar (Valentin 21.11.: "dass durch eine Scrollbar plötzlich Platz eingenommen wird und dann
 * Linien nicht mehr verbunden sind in einer Tabelle") is a head cell that does not stand over its body cells within
 * 0.5 px, also when head and body sit in two tables, or a gap between neighbouring head cells, so a line through the
 * head breaks.
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
 * sideways says so with `data-layout-check="scroll-x"`; a code block (`pre`) keeps its lines and may scroll, and a
 * toolbar (`role="toolbar"`) may scroll below 768 px (K15).
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
 * scrollbar never takes its width in a test. Pass them to `chromium.launch`, and test in narrow desktop windows without
 * touch: with `isMobile` or `hasTouch`, Chromium draws overlay scrollbars that take no room. Check `scrollbarWidth()`.
 */
export const classicScrollbars: { ignoreDefaultArgs: string[] } = { ignoreDefaultArgs: ["--hide-scrollbars"] };

/**
 * How much room a vertical scrollbar takes in this page, in px. Runs in the page: pass it to `page.evaluate`. A test
 * that relies on classic scrollbars checks that this is above 0: Chromium draws overlay scrollbars that take no room
 * when the page emulates a phone (`isMobile` or `hasTouch`), even with `classicScrollbars`, and such a run measures
 * nothing a desktop scrollbar would change.
 */
export function scrollbarWidth(): number {
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;top:-9999px;left:0;width:100px;height:100px;overflow:scroll";
  document.body.append(probe);
  const width = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  return width;
}

export type LayoutProblemOptions = {
  /** The element to check; the whole document by default. */
  root?: string;
  /** Boxes whose children overlap or clip on purpose, or that lie over a sibling on purpose; they and everything inside them are skipped. */
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
  /** Head and body columns that do not line up, or a head line with a gap: the scrollbar took room in one of them. */
  scrollbar: string[];
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
      scrollbar: [],
      sideways: false,
      problems: [`no element matches ${options.root}`],
    };
  const ignore = options.ignore ?? ".k2b-avatar-stack, [data-layout-check='skip']";
  const slack = options.slack ?? 7;
  // A visually hidden box (1 px, clipped, such as `.k2b-sr-only` or a head the sidebar makes redundant) keeps its
  // content for screen readers on purpose; nothing inside it is laid out for the eye.
  const hidden = new Map<Element, boolean>();
  const visuallyHidden = (element: Element | null): boolean => {
    if (!element || element === document.documentElement) return false;
    const known = hidden.get(element);
    if (known !== undefined) return known;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const clipped = (style.clipPath === "inset(50%)" || style.clip === "rect(0px, 0px, 0px, 0px)") && (rect.width <= 1 || rect.height <= 1);
    const result = clipped || visuallyHidden(element.parentElement);
    hidden.set(element, result);
    return result;
  };
  const seen = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      element.checkVisibility({ visibilityProperty: true, opacityProperty: true }) &&
      !visuallyHidden(element)
    );
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
  // A code block (`pre`) keeps its lines and scrolls them sideways on purpose.
  const scrollsOnPurpose = (box: HTMLElement) =>
    box.getAttribute("data-layout-check") === "scroll-x" ||
    box.tagName === "PRE" ||
    (box.getAttribute("role") === "toolbar" && window.innerWidth < 768);
  const found = { overlap: [] as string[], spill: [] as string[], cut: [] as string[], scroll: [] as string[] };
  for (const box of [root, ...Array.from(root.querySelectorAll("*"))]) {
    if (!(box instanceof HTMLElement) || !seen(box) || box.closest(ignore)) continue;
    const style = getComputedStyle(box);
    if (/flex|grid/.test(style.display)) {
      const children = Array.from(box.children)
        .flatMap(drawn)
        // An ignored box also takes no part as a sibling, such as a grip that lies over its column on purpose (K13).
        .filter((child) => seen(child) && inFlow(child) && !child.matches(ignore));
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
  // Line break by scrollbar: the cells of a head row and of a body row with as many cells share their edges. A table
  // with a head and no body rows is a head of its own; its body is the next table with rows and no head.
  const scrollbar: string[] = [];
  const shownCells = (row: Element) => Array.from(row.children).filter((cell) => seen(cell));
  const plainRow = (row: Element, count: number) =>
    seen(row) && shownCells(row).length === count && shownCells(row).every((cell) => (cell as HTMLTableCellElement).colSpan <= 1);
  const tables = Array.from(root.querySelectorAll("table")).filter((table) => seen(table) && !table.closest(ignore));
  for (const [index, table] of tables.entries()) {
    const head = table.querySelector(":scope > thead > tr");
    if (!head || !seen(head)) continue;
    const cells = shownCells(head);
    if (cells.length === 0) continue;
    const bodyOf = (owner: Element) => Array.from(owner.querySelectorAll(":scope > tbody > tr")).find((row) => plainRow(row, cells.length));
    const body =
      bodyOf(table) ??
      tables
        .slice(index + 1)
        .filter((next) => !next.querySelector(":scope > thead > tr"))
        .map(bodyOf)
        .find(Boolean);
    const edges = cells.map((cell) => cell.getBoundingClientRect());
    for (let k = 1; k < edges.length; k++)
      if (edges[k]!.left - edges[k - 1]!.right > 0.5)
        scrollbar.push(
          `line break by scrollbar: ${name(table)} head line has a ${Math.round(edges[k]!.left - edges[k - 1]!.right)} px gap before column ${k + 1}`,
        );
    if (!body) continue;
    const below = shownCells(body).map((cell) => cell.getBoundingClientRect());
    for (const [k, top] of edges.entries()) {
      const shift = Math.max(Math.abs(top.left - below[k]!.left), Math.abs(top.right - below[k]!.right));
      if (shift > 0.5)
        scrollbar.push(
          `line break by scrollbar: column ${k + 1} of ${name(table)} stands ${Math.round(shift * 10) / 10} px off its body cells`,
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
    ...scrollbar,
    ...(sideways ? [`the page scrolls sideways (${page.scrollWidth} px)`] : []),
  ];
  return { ...found, double, scrollbar, sideways, problems };
}
