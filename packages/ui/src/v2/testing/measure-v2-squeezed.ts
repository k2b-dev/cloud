/**
 * The squeezed-text rule of `measureV2Layout` (break-ui 25.11.): no text is pressed by its neighbours to a box of a few
 * px, so its words are gone (a sender beside too many marks), or to one letter per line (as "To" beside a long
 * sender). A visually hidden name clips itself on purpose and is no finding.
 */

export type SqueezedOptions = {
  /** The element to measure. */
  root: string;
  /** Subtrees whose inside is never measured (free drawing in `Canvas`). */
  skip: string;
};

/** Runs in the page: closes over nothing. */
export function measureSqueezedInPage(options: SqueezedOptions): { squeezed: string[] } {
  const squeezed: string[] = [];
  const root = document.querySelector(options.root);
  if (!root) return { squeezed };
  const round = (value: number) => Math.round(value * 100) / 100;
  const name = (element: Element) => {
    const marker = element.getAttribute("data-probe");
    if (marker) return `[data-probe="${marker}"]`;
    const classes = typeof element.className === "string" ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
    return `${element.tagName.toLowerCase()}${classes.map((c) => `.${c}`).join("")}`;
  };
  const labelOf = (element: Element) => (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  // Kept only as a name: the visually hidden label of 1 px clips itself on purpose.
  const keptAsName = (element: Element) => {
    for (let node: Element | null = element; node && node !== root; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.clipPath !== "none" || (style.clip !== "auto" && style.clip !== "")) return true;
      if (style.position === "absolute" && node.getBoundingClientRect().width <= 1) return true;
    }
    return false;
  };
  const shown = (element: Element) => element.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const seen = new Set<Element>();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    const words = node.textContent?.trim() ?? "";
    if (!parent || !words || seen.has(parent) || parent.closest(options.skip) || parent.closest("script, style, template")) continue;
    if (!shown(parent) || keptAsName(parent)) continue;
    seen.add(parent);
    const box = parent.getBoundingClientRect();
    if (box.height <= 0) continue;
    // A box of a few px holds no word of 2 letters or more: its text is gone (a sender of width 0 beside many marks).
    // The box that shows it counts: its own, or an ancestor that clips sideways and was pressed to a few px itself.
    const fontSize = Number.parseFloat(getComputedStyle(parent).fontSize) || 14;
    const least = Math.min(4, fontSize / 3);
    let shownWidth = box.width;
    // Text that wrapped wholly out of sight below (or above) a box that hides what wraps gave way whole on purpose (the
    // key figures of a StatusRow): it is not pressed, it is gone as a whole.
    let outOfSight = false;
    for (let ancestor = parent.parentElement; ancestor && ancestor !== root.parentElement; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (style.display === "contents") continue;
      const clip = ancestor.getBoundingClientRect();
      if ((style.overflowY === "hidden" || style.overflowY === "clip") && (box.top >= clip.bottom - 0.5 || box.bottom <= clip.top + 0.5))
        outOfSight = true;
      if (style.overflowX !== "hidden" && style.overflowX !== "clip") continue;
      shownWidth = Math.min(shownWidth, clip.width);
    }
    if (outOfSight) continue;
    if ([...words].length >= 2 && shownWidth < least) {
      squeezed.push(
        `${name(parent)} "${labelOf(parent)}" is ${round(shownWidth)} px wide; its text is gone, give it room or cut it with "…"`,
      );
      continue;
    }
    // One letter per line: three or more line boxes, none wider than about a letter and a half, and more lines than
    // words (a list of short lines broken on purpose, "1.", "2.", "3.", is no finding).
    const range = document.createRange();
    range.selectNodeContents(node);
    const rows = new Map<number, number>();
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width <= 0 || rect.height <= 0) continue;
      const top = Math.round(rect.top);
      rows.set(top, (rows.get(top) ?? 0) + rect.width);
    }
    const widths = [...rows.values()];
    const wordCount = words.split(/\s+/).length;
    if (widths.length >= 3 && widths.length > wordCount && [...words].length >= 3 && Math.max(...widths) <= fontSize * 1.6)
      squeezed.push(
        `${name(parent)} "${labelOf(parent)}" stands one letter per line (${widths.length} lines of at most ${round(Math.max(...widths))} px); keep it on one line`,
      );
  }
  return { squeezed };
}

/**
 * Rows past their edge (Files 26.11.): a row that runs past its column or the screen, and a part of a row (its date,
 * its marks) that stands past the row. A wide table that scrolls sideways is no finding. Runs in the page: closes
 * over nothing.
 */
export function measurePastInPage(options: SqueezedOptions): { past: string[] } {
  const past: string[] = [];
  const root = document.querySelector(options.root);
  if (!root) return { past };
  const round = (value: number) => Math.round(value * 100) / 100;
  const labelOf = (element: Element) => (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  const screen = document.documentElement.clientWidth;
  for (const row of Array.from(root.querySelectorAll('[data-k2-part="Row"]'))) {
    if (row.closest(options.skip) || row.closest(".k2-table-scroll")) continue;
    if (!row.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
    const box = row.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    const column = row.parentElement?.closest("[data-k2-column]")?.getBoundingClientRect();
    const edge = Math.min(screen, column ? column.right : Number.POSITIVE_INFINITY);
    if (box.right > edge + 0.5) {
      past.push(`row "${labelOf(row)}" runs ${round(box.right - edge)} px past the edge of its column; it fits its column`);
      continue;
    }
    for (const part of Array.from(row.children)) {
      if (part.matches(".k2-row-open")) continue;
      const own = part.getBoundingClientRect();
      if (own.width > 0 && own.right > box.right + 0.5)
        past.push(`${part.className} "${labelOf(part)}" stands ${round(own.right - box.right)} px past its row; it stays inside`);
    }
    // The words of a line as they show: a line that does not clip spills what has no break (an address, JSON) past
    // its box, under what stands beside it (marks, a deed, the time) or past the row (U2 26.11.).
    const inner = box.right - Number.parseFloat(getComputedStyle(row).paddingRight);
    const beside = Array.from(row.querySelectorAll(":scope > :is(.k2-row-marks, .k2-row-end, .k2-row-time)"));
    for (const line of Array.from(row.querySelectorAll<HTMLElement>(":scope > :is(.k2-row-l1, .k2-row-l2, .k2-row-l3)"))) {
      const own = line.getBoundingClientRect();
      if (own.width <= 0) continue;
      const right = getComputedStyle(line).overflowX === "visible" ? own.left + line.scrollWidth : own.right;
      if (right > inner + 0.5) {
        past.push(`${line.className} "${labelOf(line)}" runs ${round(right - inner)} px past its row; it ends with "…"`);
        continue;
      }
      for (const part of beside) {
        const other = part.getBoundingClientRect();
        // on the same line: more than the 2 px the marks reach into the line above them
        const sameLine = Math.min(own.bottom, other.bottom) - Math.max(own.top, other.top) > 4;
        if (other.width > 0 && right > other.left + 0.5 && own.left < other.right && sameLine)
          past.push(`${line.className} "${labelOf(line)}" lies under ${part.className}; it ends with "…" before it`);
      }
    }
  }
  return { past };
}
