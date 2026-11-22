/**
 * The layout self-check of Cloud flach (K15), the mockups' `?check=1` as a function for browser tests. It finds
 * siblings in a flex or grid box that overlap, content that spills out of its box, text that is cut without an
 * ellipsis or a fade, a double line (two parallel visible borders that touch or lie at most 1 px apart, also across
 * components; "one line, one owner", K2), a line break by scrollbar, and a page that scrolls sideways.
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
 * carries `data-layout-check="skip"`. A touch hit area (an empty, invisible, positioned `::before` or `::after` that
 * reaches past a small control) is no spill and no cut; it needs no exception.
 */

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
  /**
   * Turns on the checks of the flat look (Cloud flach K2, K11, K13): `true` for all four, or a list. Off by default, so
   * a page that passes today keeps passing; their lines join `problems` only when they are on. `ignore` does not apply
   * to them.
   */
  flat?: boolean | FlatProblemKind[];
  /**
   * The flat areas: columns whose inner edges lines and fills reach (`short-edge`) and inside which only the type roles
   * are allowed (`type-role`). The innermost area owns an element. By default the columns of every `AppWorkspace`
   * (sidebar, main and its panes, detail, drawer) and any box with `data-layout-area`.
   */
  areas?: string;
};

/**
 * The checks of the flat look:
 *
 * - `short-edge`: a line (a border of at most 1 px or a 1 px box-shadow line) or a fill of a row, cell, selection, or
 *   notice in a flat area does not reach its area's inner edge within 0.5 px. A scrollbar gutter is no excuse.
 * - `near-double`: two parallel lines 0 to 8 px apart that run side by side over half of the shorter one or more.
 * - `grip-off-center`: a resize grip that is not centred on its edge within 1 px, or that lies behind something.
 * - `type-role`: text in a flat area whose size, line height, and weight are no type role of `--k2b-type-roles`.
 */
export type FlatProblemKind = "short-edge" | "near-double" | "grip-off-center" | "type-role";

export type LayoutProblems = {
  overlap: string[];
  spill: string[];
  cut: string[];
  double: string[];
  /** Head and body columns that do not line up, or a head line with a gap: the scrollbar took room in one of them. */
  scrollbar: string[];
  sideways: boolean;
  /** `short-edge` findings; empty unless `flat` turns the kind on. */
  shortEdge: string[];
  /** `near-double` findings; empty unless `flat` turns the kind on. */
  nearDouble: string[];
  /** `grip-off-center` findings; empty unless `flat` turns the kind on. */
  gripOffCenter: string[];
  /** `type-role` findings; empty unless `flat` turns the kind on. */
  typeRole: string[];
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
      double: [],
      scrollbar: [],
      sideways: false,
      shortEdge: [],
      nearDouble: [],
      gripOffCenter: [],
      typeRole: [],
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
    // A clipped or overflow-hidden box of at most 1 px, such as `.k2b-sr-only` or the primary action's label in a head.
    const clipped =
      (style.clipPath === "inset(50%)" || style.clip === "rect(0px, 0px, 0px, 0px)" || ["hidden", "clip"].includes(style.overflowX)) &&
      (rect.width <= 1 || rect.height <= 1);
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
    // What a person sees: every element and every run of text, except what a visually hidden box keeps for screen
    // readers (its text runs on unclipped in the layout, but nobody sees it, so it is no reason to report a hit area).
    const reaches = Array.from(box.querySelectorAll("*"))
      .filter((element) => !visuallyHidden(element))
      .map((element) => element.getBoundingClientRect());
    const texts = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    for (let text = texts.nextNode(); text; text = texts.nextNode()) {
      if (!text.textContent?.trim() || visuallyHidden(text.parentElement)) continue;
      const range = document.createRange();
      range.selectNodeContents(text);
      reaches.push(range.getBoundingClientRect());
    }
    if (reaches.some((rect) => rect.width > 0 && (rect.left < left || rect.right > right))) return false;
    return ![box, ...Array.from(box.querySelectorAll("*"))].some(drawsBeyond);
  };
  const found = { overlap: [] as string[], spill: [] as string[], cut: [] as string[] };
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
      else if (!scrolls && style.textOverflow !== "ellipsis" && !masked)
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
  // Pairs that `double` reports; `near-double` does not report them again.
  const ids = new Map<Element, number>();
  const key = (element: Element) => {
    if (!ids.has(element)) ids.set(element, ids.size);
    return ids.get(element)!;
  };
  const doubled = new Set<string>();
  for (const list of [bands.horizontal, bands.vertical]) {
    list.sort((a, b) => a.across0 - b.across0);
    for (const [index, a] of list.entries())
      for (const b of list.slice(index + 1)) {
        if (b.across0 - a.across1 > 1) break;
        if (a.element === b.element || collapsedPair(a.element, b.element)) continue;
        const shared = Math.min(a.along1, b.along1) - Math.max(a.along0, b.along0);
        if (shared > 1) doubled.add(`${key(a.element)}:${a.side}|${key(b.element)}:${b.side}`);
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

  // The checks of the flat look. They run only when `flat` turns them on, and `ignore` does not apply to them.
  const kinds: FlatProblemKind[] =
    options.flat === true ? ["short-edge", "near-double", "grip-off-center", "type-role"] : options.flat || [];
  const on = (kind: FlatProblemKind) => kinds.includes(kind);
  const areaSelector =
    options.areas ??
    "[data-layout-area], .k2b-app-workspace :is(.k2b-app-workspace__sidebar, .k2b-app-workspace__main, [data-workspace-main-region], .k2b-app-workspace__detail, .k2b-app-workspace__drawer)";
  const everything = kinds.length ? [root, ...Array.from(root.querySelectorAll("*"))].filter((element) => seen(element)) : [];
  const px = (value: number) => Math.round(value * 10) / 10;
  const visibleColor = (color: string) => !transparent(color.replace(/\s+/g, "")) && !/\/\s*0\)$/.test(color);
  const radius = (style: CSSStyleDeclaration) =>
    ["top-left", "top-right", "bottom-right", "bottom-left"].some(
      (corner) => Number.parseFloat(style.getPropertyValue(`border-${corner}-radius`)) > 0,
    );
  const sides = ["top", "right", "bottom", "left"] as const;
  const borderShown = (style: CSSStyleDeclaration, side: string) => {
    const line = style.getPropertyValue(`border-${side}-style`);
    return (
      Number.parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0 &&
      line !== "none" &&
      line !== "hidden" &&
      visibleColor(style.getPropertyValue(`border-${side}-color`))
    );
  };
  // Framed by definition (a field, button, card, chip): round corners, or a border on three sides or more. Its edges
  // are the frame of one object, not lines that structure a column.
  const framed = (style: CSSStyleDeclaration) => radius(style) || sides.filter((side) => borderShown(style, side)).length >= 3;
  // A 1 px line drawn as a shadow: no blur, no spread, and an offset of at most 1 px on one axis only.
  type ShadowLine = { side: "top" | "bottom" | "left" | "right"; width: number; inset: boolean };
  const shadowLines = (style: CSSStyleDeclaration): ShadowLine[] => {
    if (style.boxShadow === "none") return [];
    const lines: ShadowLine[] = [];
    for (const shadow of style.boxShadow.split(/,(?![^(]*\))/)) {
      const color = shadow.match(/(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\([^)]*\)|#[0-9a-f]+/i)?.[0] ?? "";
      if (color && !visibleColor(color)) continue;
      const inset = /\binset\b/.test(shadow);
      const [x = 0, y = 0, blur = 0, spread = 0] = shadow
        .replace(color, "")
        .replace(/\binset\b/, "")
        .trim()
        .split(/\s+/)
        .map((part) => Number.parseFloat(part));
      if (blur !== 0 || spread !== 0 || (x !== 0 && y !== 0)) continue;
      if (y !== 0 && Math.abs(y) <= 1) lines.push({ side: y > 0 !== inset ? "bottom" : "top", width: Math.abs(y), inset });
      if (x !== 0 && Math.abs(x) <= 1) lines.push({ side: x > 0 !== inset ? "right" : "left", width: Math.abs(x), inset });
    }
    return lines;
  };
  const owner = (element: Element) => element.parentElement?.closest(areaSelector) ?? null;
  const inner = (area: Element) => {
    const rect = area.getBoundingClientRect();
    const style = getComputedStyle(area);
    return {
      left: rect.left + Number.parseFloat(style.borderLeftWidth),
      right: rect.right - Number.parseFloat(style.borderRightWidth),
    };
  };
  // A box that floats above its column (a menu, a popover, a hit area) is no row of it.
  const floats = (element: Element, area: Element) => {
    for (let box: Element | null = element; box && box !== area; box = box.parentElement)
      if (["absolute", "fixed"].includes(getComputedStyle(box).position)) return true;
    return false;
  };
  const backdrop = (element: Element) => {
    for (let box = element.parentElement; box; box = box.parentElement) {
      const color = getComputedStyle(box).backgroundColor;
      if (visibleColor(color)) return color;
    }
    return "";
  };

  // short-edge: every horizontal line and every fill of a box in a flat area is a segment; segments of one area at the
  // same height join into runs, and a run that spans at least half the area reaches both of its inner edges.
  const shortEdge: string[] = [];
  if (on("short-edge")) {
    type Segment = { area: Element; key: string; what: string; x0: number; x1: number; element: Element };
    const segments: Segment[] = [];
    for (const element of everything) {
      if (!(element instanceof HTMLElement) || element.matches(areaSelector)) continue;
      const area = owner(element);
      if (
        !area ||
        floats(element, area) ||
        element.matches("input, select, textarea, [role='progressbar'], [role='meter'], [role='slider'], [role='separator']")
      )
        continue;
      const style = getComputedStyle(element);
      if (style.display === "inline") continue;
      const rect = element.getBoundingClientRect();
      const add = (key: string, what: string) => segments.push({ area, key, what, x0: rect.left, x1: rect.right, element });
      if (!framed(style)) {
        for (const side of ["top", "bottom"] as const)
          if (borderShown(style, side) && Number.parseFloat(style.getPropertyValue(`border-${side}-width`)) <= 1)
            add(`line ${Math.round(side === "top" ? rect.top : rect.bottom)}`, "line");
        for (const line of shadowLines(style))
          if (line.side === "top" || line.side === "bottom")
            add(`line ${Math.round(line.side === "top" ? rect.top : rect.bottom)}`, "line");
      }
      if (!radius(style) && rect.height >= 12 && visibleColor(style.backgroundColor) && style.backgroundColor !== backdrop(element))
        add(`fill ${Math.round(rect.top)} ${Math.round(rect.bottom)} ${style.backgroundColor}`, "fill");
    }
    const groups = new Map<Element, Map<string, Segment[]>>();
    for (const segment of segments) {
      const byKey = groups.get(segment.area) ?? new Map<string, Segment[]>();
      byKey.set(segment.key, [...(byKey.get(segment.key) ?? []), segment]);
      groups.set(segment.area, byKey);
    }
    for (const [area, byKey] of groups) {
      const edge = inner(area);
      const width = edge.right - edge.left;
      for (const list of byKey.values()) {
        list.sort((a, b) => a.x0 - b.x0);
        const runs: Segment[][] = [];
        for (const segment of list) {
          const run = runs.at(-1);
          if (run && segment.x0 <= Math.max(...run.map((part) => part.x1)) + 1) run.push(segment);
          else runs.push([segment]);
        }
        for (const run of runs) {
          const x0 = run[0]!.x0;
          const last = run.reduce((a, b) => (b.x1 > a.x1 ? b : a));
          if (last.x1 - x0 < width / 2) continue;
          const gaps = [
            [x0 - edge.left, run[0]!.element, "left"],
            [edge.right - last.x1, last.element, "right"],
          ] as const;
          for (const [gap, element, side] of gaps)
            if (Math.abs(gap) > 0.5)
              shortEdge.push(
                `short-edge: the ${run[0]!.what} of ${name(element)} ${gap > 0 ? `stops ${px(gap)} px short of` : `runs ${px(-gap)} px past`} the ${side} edge of ${name(area)}`,
              );
        }
      }
    }
  }

  // near-double: two parallel lines of different elements 0 to 8 px apart that run side by side over at least half of
  // the shorter one read as one doubled line. The edge of a frame (a field, button, card) is no line.
  const nearDouble: string[] = [];
  if (on("near-double")) {
    type Line = Band;
    const lines = { horizontal: [] as Line[], vertical: [] as Line[] };
    for (const element of everything) {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (framed(style)) continue;
      // `shift` moves an outer shadow line out of the box: it lies beside its edge, an inset one inside it.
      const push = (side: string, width: number, shift = 0, label = side) => {
        const band = { element, side: label };
        if (side === "top")
          lines.horizontal.push({
            ...band,
            across0: rect.top - shift,
            across1: rect.top - shift + width,
            along0: rect.left,
            along1: rect.right,
          });
        if (side === "bottom")
          lines.horizontal.push({
            ...band,
            across0: rect.bottom + shift - width,
            across1: rect.bottom + shift,
            along0: rect.left,
            along1: rect.right,
          });
        if (side === "left")
          lines.vertical.push({
            ...band,
            across0: rect.left - shift,
            across1: rect.left - shift + width,
            along0: rect.top,
            along1: rect.bottom,
          });
        if (side === "right")
          lines.vertical.push({
            ...band,
            across0: rect.right + shift - width,
            across1: rect.right + shift,
            along0: rect.top,
            along1: rect.bottom,
          });
      };
      for (const side of sides) if (borderShown(style, side)) push(side, Number.parseFloat(style.getPropertyValue(`border-${side}-width`)));
      for (const line of shadowLines(style)) push(line.side, line.width, line.inset ? 0 : line.width, `${line.side} shadow`);
    }
    for (const list of [lines.horizontal, lines.vertical]) {
      list.sort((a, b) => a.across0 - b.across0);
      for (const [index, a] of list.entries())
        for (const b of list.slice(index + 1)) {
          const gap = b.across0 - a.across1;
          if (gap > 8) break;
          if (gap <= 0 || a.element === b.element || collapsedPair(a.element, b.element)) continue;
          const pair = [`${key(a.element)}:${a.side}`, `${key(b.element)}:${b.side}`];
          if (doubled.has(pair.join("|")) || doubled.has(pair.reverse().join("|"))) continue;
          const shared = Math.min(a.along1, b.along1) - Math.max(a.along0, b.along0);
          const shorter = Math.min(a.along1 - a.along0, b.along1 - b.along0);
          if (shorter > 0 && shared >= shorter / 2)
            nearDouble.push(
              `near-double: ${name(a.element)} ${a.side} and ${name(b.element)} ${b.side} lie ${px(gap)} px apart over ${Math.round(shared)} px`,
            );
        }
    }
  }

  // grip-off-center: a resize grip sits on the middle of its edge, across within 1 px and along within 1 px, and
  // nothing lies over it. The edge is the start or end of the column the separator controls, else the line between
  // the separator's neighbours, else the separator's own middle.
  const gripOffCenter: string[] = [];
  if (on("grip-off-center")) {
    // A separator may be 0 px wide: its grip and hit area reach past it.
    const separators = Array.from(root.querySelectorAll("[role='separator']")).filter(
      (element) => element.checkVisibility({ visibilityProperty: true }) && !visuallyHidden(element),
    );
    // Hit testing sees what lies on top, also boxes that let the pointer through.
    const probe = document.createElement("style");
    probe.textContent = "*, *::before, *::after { pointer-events: auto !important; }";
    document.head.append(probe);
    try {
      for (const separator of separators) {
        const grip = Array.from(separator.querySelectorAll("*")).find(
          (child) => seen(child) && visibleColor(getComputedStyle(child).backgroundColor),
        );
        if (!grip) continue;
        const vertical = separator.getAttribute("aria-orientation") !== "horizontal";
        const own = separator.getBoundingClientRect();
        const box = grip.getBoundingClientRect();
        const middle = vertical ? (box.left + box.right) / 2 : (box.top + box.bottom) / 2;
        const along = vertical ? (box.top + box.bottom) / 2 : (box.left + box.right) / 2;
        const controlled = document.getElementById(separator.getAttribute("aria-controls") ?? "");
        const start = (separator.getAttribute("data-workspace-resize-edge") ?? separator.getAttribute("data-resize-edge")) === "start";
        const neighbours = [separator.previousElementSibling, separator.nextElementSibling].map((sibling) =>
          sibling && seen(sibling) ? sibling.getBoundingClientRect() : null,
        );
        let edge = vertical ? (own.left + own.right) / 2 : (own.top + own.bottom) / 2;
        let extent = vertical ? [own.top, own.bottom] : [own.left, own.right];
        if (controlled && seen(controlled)) {
          const rect = controlled.getBoundingClientRect();
          edge = vertical ? (start ? rect.left : rect.right) : start ? rect.top : rect.bottom;
          extent = vertical
            ? [Math.max(own.top, rect.top), Math.min(own.bottom, rect.bottom)]
            : [Math.max(own.left, rect.left), Math.min(own.right, rect.right)];
        } else if (neighbours[0] && neighbours[1])
          edge = vertical ? (neighbours[0].right + neighbours[1].left) / 2 : (neighbours[0].bottom + neighbours[1].top) / 2;
        // The part of the edge in the viewport is the line a person sees.
        const [from, to] = [Math.max(extent[0]!, 0), Math.min(extent[1]!, vertical ? window.innerHeight : window.innerWidth)];
        const label = separator.getAttribute("aria-label") ?? name(separator);
        if (Math.abs(middle - edge) > 1)
          gripOffCenter.push(`grip-off-center: the grip of "${label}" sits ${px(middle - edge)} px off its edge at ${Math.round(edge)} px`);
        if (to > from && Math.abs(along - (from + to) / 2) > 1)
          gripOffCenter.push(
            `grip-off-center: the grip of "${label}" sits ${px(along - (from + to) / 2)} px off the middle of its ${Math.round(to - from)} px edge`,
          );
        const top = document.elementFromPoint(vertical ? middle : along, vertical ? along : middle);
        if (top && top !== grip && !grip.contains(top))
          gripOffCenter.push(`grip-off-center: the grip of "${label}" lies behind ${name(top)}`);
      }
    } finally {
      probe.remove();
    }
  }

  // type-role: in a flat area every run of text has a type role: a size of `--k2b-type-roles` with one of its line
  // heights and weights. Reading text (Markdown, an editor) keeps its own scale, and initials in an avatar are a symbol.
  const typeRole: string[] = [];
  if (on("type-role")) {
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const length = (value: string) => Number.parseFloat(value) * (value.endsWith("rem") ? rem : 1);
    const rolesOf = new Map<Element, { name: string; size: number; lines: number[]; weights: number[] }[]>();
    const roles = (area: Element) => {
      if (!rolesOf.has(area))
        rolesOf.set(
          area,
          getComputedStyle(area)
            .getPropertyValue("--k2b-type-roles")
            // A minifier may put empty comments between the values.
            .replace(/\/\*.*?\*\//g, " ")
            .split(",")
            .map((role) => role.trim().split("/"))
            .filter(([head]) => head?.trim())
            .map(([head = "", weights = ""]) => {
              const [label = "", size = "", ...lines] = head.trim().split(/\s+/);
              return { name: label, size: length(size), lines: lines.map(length), weights: weights.trim().split(/\s+/).map(Number) };
            }),
        );
      return rolesOf.get(area)!;
    };
    const reported = new Set<Element>();
    const texts = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let text = texts.nextNode(); text; text = texts.nextNode()) {
      const element = text.parentElement;
      if (!element || reported.has(element) || !text.textContent?.trim() || !seen(element)) continue;
      const area = element.closest(areaSelector);
      if (!area || element.closest("[contenteditable]:not([contenteditable='false']), .k2b-markdown, .k2b-avatar, svg, script, style"))
        continue;
      const list = roles(area);
      if (list.length === 0) {
        if (!reported.has(area)) typeRole.push(`type-role: ${name(area)} has no type roles (--k2b-type-roles is not set)`);
        reported.add(area);
        continue;
      }
      const style = getComputedStyle(element);
      const size = Number.parseFloat(style.fontSize);
      const line = Number.parseFloat(style.lineHeight);
      const weight = Number(style.fontWeight);
      const fits = list.some(
        (role) =>
          Math.abs(role.size - size) <= 0.25 &&
          role.lines.some((height) => Math.abs(height - line) <= 0.5) &&
          role.weights.includes(weight),
      );
      if (fits) continue;
      reported.add(element);
      typeRole.push(`type-role: ${name(element)} in ${name(area)} is ${px(size)}px/${style.lineHeight}/${style.fontWeight}, no type role`);
    }
  }

  const problems = [
    ...found.overlap,
    ...found.spill,
    ...found.cut,
    ...double,
    ...scrollbar,
    ...(sideways ? [`the page scrolls sideways (${page.scrollWidth} px)`] : []),
    ...shortEdge,
    ...nearDouble,
    ...gripOffCenter,
    ...typeRole,
  ];
  return { ...found, double, scrollbar, sideways, shortEdge, nearDouble, gripOffCenter, typeRole, problems };
}
