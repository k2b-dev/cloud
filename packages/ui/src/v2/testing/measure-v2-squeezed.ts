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
    const fontSize = Number.parseFloat(getComputedStyle(parent).fontSize) || 14;
    if ([...words].length >= 2 && box.width < Math.min(4, fontSize / 3)) {
      squeezed.push(
        `${name(parent)} "${labelOf(parent)}" is ${round(box.width)} px wide; its text is gone, give it room or cut it with "…"`,
      );
      continue;
    }
    // One letter per line: three or more line boxes, none wider than about a letter and a half.
    const range = document.createRange();
    range.selectNodeContents(node);
    const rows = new Map<number, number>();
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width <= 0 || rect.height <= 0) continue;
      const top = Math.round(rect.top);
      rows.set(top, (rows.get(top) ?? 0) + rect.width);
    }
    const widths = [...rows.values()];
    if (widths.length >= 3 && [...words].length >= 3 && Math.max(...widths) <= fontSize * 1.6)
      squeezed.push(
        `${name(parent)} "${labelOf(parent)}" stands one letter per line (${widths.length} lines of at most ${round(Math.max(...widths))} px); keep it on one line`,
      );
  }
  return { squeezed };
}
