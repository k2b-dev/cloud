/**
 * The text checks of `measureV2Layout`, on their own: what a person cannot read although every line and edge is right.
 *
 * - **overlap:** a control (a link, a button, a field, a switch) and text that is not its own never share a place:
 *   a key figure that runs under a switch, a label under a button. Floating surfaces (a menu, a dialog, a toast, the
 *   floating main action) are a layer of their own and measured on their own.
 * - **number:** a number, an amount, a date or a time is never cut ("12.345.678,…" reads as another number): the
 *   cells of a `numeric` column, and any one-line text whose words are a number with at most a short unit.
 * - **clip:** text cut at the edge of a box that clips is cut with "…" or not at all, never through a sign; "…" only
 *   reaches text that runs inline in the box that cuts it, not text in a flex item or an inline block inside it.
 */

export type V2TextResult = { overlap: string[]; number: string[]; clip: string[] };

/** Runs in the page: closes over nothing. */
export function measureTextInPage(options: { root: string; skip: string; controls: string }): V2TextResult {
  const result: V2TextResult = { overlap: [], number: [], clip: [] };
  const root = document.querySelector(options.root);
  if (!root) return result;
  type Box = { left: number; right: number; top: number; bottom: number };
  const words = (text: string | null) => (text ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  const name = (element: Element) => {
    const part = element.closest("[data-k2-part]")?.getAttribute("data-k2-part");
    const classes = Array.from(element.classList).slice(0, 2);
    return `<${element.tagName.toLowerCase()}${classes.length ? `.${classes.join(".")}` : ""}>${part ? ` in ${part}` : ""}`;
  };
  const shown = (element: Element) => element.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  const meet = (a: Box, b: Box): Box => ({
    left: Math.max(a.left, b.left),
    right: Math.min(a.right, b.right),
    top: Math.max(a.top, b.top),
    bottom: Math.min(a.bottom, b.bottom),
  });
  const size = (box: Box) => ({ width: box.right - box.left, height: box.bottom - box.top });

  // What a person sees inside an element: the viewport, cut by the element itself and every ancestor that clips or
  // scrolls (content scrolled away is not seen now).
  const seen = new Map<Element, Box>();
  const seenIn = (element: Element): Box => {
    const known = seen.get(element);
    if (known) return known;
    let box: Box = element.parentElement ? seenIn(element.parentElement) : { left: 0, right: innerWidth, top: 0, bottom: innerHeight };
    const style = getComputedStyle(element);
    if (style.display !== "contents") {
      const r = element.getBoundingClientRect();
      if (style.overflowX !== "visible") box = { ...box, left: Math.max(box.left, r.left), right: Math.min(box.right, r.right) };
      if (style.overflowY !== "visible") box = { ...box, top: Math.max(box.top, r.top), bottom: Math.min(box.bottom, r.bottom) };
    }
    seen.set(element, box);
    return box;
  };
  // What cuts sideways for good, and which box does it: hidden or clip, up to the first scroller (what a scroller
  // hides, a person scrolls to).
  const hardCut = (element: Element): { left: number; right: number; by: Element | null } => {
    let cut = { left: Number.NEGATIVE_INFINITY, right: Number.POSITIVE_INFINITY, by: null as Element | null };
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display !== "contents") {
        if (node !== element && ["auto", "scroll"].includes(style.overflowX)) break;
        if (["hidden", "clip"].includes(style.overflowX)) {
          const r = node.getBoundingClientRect();
          if (r.right < cut.right) cut = { left: Math.max(cut.left, r.left), right: r.right, by: node };
          else cut = { ...cut, left: Math.max(cut.left, r.left) };
        }
      }
      if (node === root) break;
    }
    return cut;
  };
  const floating =
    "[popover], dialog, [role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox'], [data-slot='toast'], .k2-fab, .k2-drawer";
  const layer = (element: Element) => {
    const surface = element.closest(floating);
    return surface && surface !== root && root.contains(surface) ? surface : null;
  };
  const skipped = (element: Element) => (options.skip ? element.closest(options.skip) !== null : false);

  // Every visible run of text, line by line, with what a person sees of it.
  type Run = { node: Text; parent: Element; boxes: DOMRect[]; seen: Box[] };
  const runs: Run[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!(node instanceof Text) || !parent || !node.textContent?.trim() || skipped(parent) || !shown(parent)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const boxes = Array.from(range.getClientRects()).filter((box) => box.width > 0 && box.height > 0);
    const view = seenIn(parent);
    const parts = boxes.map((box) => meet(box, view)).filter((box) => size(box).width > 1 && size(box).height > 1);
    if (parts.length) runs.push({ node, parent, boxes, seen: parts });
  }

  // overlap
  const controlSelector =
    "a[href], button, input:not([type='hidden']), select, textarea, [role='switch'], [role='button'], [role='checkbox'], [role='tab']";
  const reported = new Set<string>();
  for (const control of Array.from(root.querySelectorAll(controlSelector))) {
    // a stretched target lies over its row on purpose; the box of a check is its input, stretched over the mark
    if (control.matches(".k2-row-open, .k2-mark-input") || skipped(control) || !shown(control)) continue;
    const r = control.getBoundingClientRect();
    const box = control.parentElement ? meet(r, seenIn(control.parentElement)) : r;
    if (size(box).width <= 2 || size(box).height <= 2) continue;
    const own = layer(control);
    for (const run of runs) {
      if (control.contains(run.node) || layer(run.parent) !== own) continue;
      // A control laid over text whole on purpose (the search of a phone head opens over its tabs) hides it; text a
      // control covers only in part is what a person sees cut.
      const area = (box: Box) => Math.max(0, size(box).width) * Math.max(0, size(box).height);
      const total = run.seen.reduce((sum, part) => sum + area(part), 0);
      const covered = run.seen.reduce((sum, part) => sum + area(meet(part, box)), 0);
      if (total > 0 && covered >= total * 0.99) continue;
      for (const part of run.seen) {
        const both = size(meet(part, box));
        if (both.width <= 2 || both.height <= 2) continue;
        const key = `${words(run.node.textContent)}|${words(control.textContent) || control.getAttribute("aria-label")}`;
        if (reported.has(key)) break;
        reported.add(key);
        result.overlap.push(
          `text "${words(run.node.textContent)}" (${name(run.parent)}) lies on control "${words(control.getAttribute("aria-label") ?? control.textContent)}" (${name(control)}) over ${Math.round(both.width)} × ${Math.round(both.height)} px; a control and text never share a place`,
        );
        break;
      }
    }
  }

  // number
  const numberLike = /^[\s+\-−±~≈]*\d[\d\s.,:'’/\-−]*(?:\s?(?:%|‰|[\p{L}€$£¥]{1,4}\.?))?$/u;
  const oneLine =
    ".k2-table td .k2-cell-line, .k2-row-time, .k2-row-meta, .k2-cell-value, .k2-chip-text, .k2-digest-date, .k2-fact-value, .k2-sh-count, .k2-gh-count, .k2-tab-count, .k2-ni-count";
  for (const element of Array.from(root.querySelectorAll(oneLine))) {
    if (skipped(element) || !shown(element)) continue;
    const text = words(element.textContent);
    if (!text || !((element.closest("td[data-numeric]") && !element.matches("[data-second]")) || numberLike.test(text))) continue;
    const cut = hardCut(element);
    const view = seenIn(element);
    let outside = 0;
    for (const run of runs) {
      if (!element.contains(run.node)) continue;
      for (const box of run.boxes) {
        // only what lies in sight: a cell of a row scrolled away is measured when it is scrolled into view
        if (box.bottom < view.top || box.top > view.bottom) continue;
        outside = Math.max(outside, box.right - cut.right, cut.left - box.left);
      }
    }
    const style = getComputedStyle(element);
    const clamped = style.webkitLineClamp !== "none" && style.webkitLineClamp !== "" && element.scrollHeight > element.clientHeight + 1;
    if (outside > 0.5 || clamped)
      result.number.push(
        `the number "${text}" in ${name(element)} is cut${outside > 0.5 ? ` by ${Math.round(outside)} px` : ""}; numbers, amounts and times are never cut (a numeric column, or room for the value)`,
      );
  }

  // clip
  const runsInline = (from: Element, to: Element) => {
    for (let node: Element | null = from; node && node !== to; node = node.parentElement) {
      const display = getComputedStyle(node).display;
      if (display !== "inline" && display !== "contents") return false;
    }
    return true;
  };
  const clipReported = new Set<Element>();
  for (const run of runs) {
    if (run.parent.closest(options.controls)) continue; // a control's label is judged by the cut check, more strictly
    const cut = hardCut(run.parent);
    if (!cut.by || clipReported.has(cut.by)) continue;
    const crossed = run.boxes.some(
      (box) => (box.right > cut.right + 0.5 && box.left < cut.right - 0.5) || (box.left < cut.left - 0.5 && box.right > cut.left + 0.5),
    );
    if (!crossed) continue;
    const by = cut.by;
    const style = getComputedStyle(by);
    const clamped = style.webkitLineClamp !== "none" && style.webkitLineClamp !== "";
    const ellipsis = style.textOverflow === "ellipsis" && (style.whiteSpace.startsWith("nowrap") || clamped);
    if (ellipsis && runsInline(run.parent, by)) continue;
    // a box whose children all run inline and that cuts without "…" is reported by the cut check already
    if (
      !ellipsis &&
      Array.from(by.children).every((child) => getComputedStyle(child).display.startsWith("inline")) &&
      by.contains(run.node) &&
      run.parent === by
    )
      continue;
    clipReported.add(by);
    result.clip.push(
      `text "${words(run.node.textContent)}" in ${name(run.parent)} is cut through a sign at the edge of ${name(by)}, without "…"; cut the text itself with "…" (not a box of things around it), or give it room`,
    );
  }
  return result;
}
