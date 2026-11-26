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
export function measureTextInPage(options: { root: string; skip: string; controls: string; covers: string }): V2TextResult {
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
  // A box in the top layer (an open dialog, a popover) or fixed to the window is not cut by the boxes it stands in.
  const escapes = (element: Element) => {
    if (getComputedStyle(element).position === "fixed") return true;
    try {
      return element.matches(":modal, :popover-open");
    } catch {
      return false;
    }
  };

  // What a person sees inside an element: the viewport, cut by the element itself and every ancestor that clips or
  // scrolls (content scrolled away is not seen now).
  const seen = new Map<Element, Box>();
  const seenIn = (element: Element): Box => {
    const known = seen.get(element);
    if (known) return known;
    const window_: Box = { left: 0, right: innerWidth, top: 0, bottom: innerHeight };
    let box: Box = element.parentElement && !escapes(element) ? seenIn(element.parentElement) : window_;
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
      if (escapes(node)) break;
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
      // Text under a control is lost, whole or in part; only a control named as laid over the page on purpose
      // (`covers`: the search of a phone head opens over its tabs while it has the focus) may hide it.
      if (options.covers && control.matches(options.covers)) continue;
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
  // A number in any locale: figures of any script (Arabic-Indic too), the separators locales use (also the Arabic
  // ones and thin or no-break spaces), a sign, a currency or short unit before or after it ("$12,345,678.90",
  // "12.345.678,90 €", Arabic-Indic figures with Arabic separators), and the direction marks a formatter puts around it
  // (format characters, \p{Cf}). A word before the number stands apart ("CHF 1’234.50"); an ID ("RE-2611") is no number.
  const numberLike =
    /^[\s\p{Cf}\p{Sm}\p{Pd}\p{Ps}]*(?:(?:\p{Sc}|\p{L}{1,3}\p{Sc}|\p{L}{1,3}\.)[\s\p{Cf}]*|\p{L}{2,3}\s+)?[\p{Sm}\p{Pd}\p{Cf}]*\p{Nd}[\p{Nd}\s\p{Cf}.,:'/\p{Pd}\p{Sm}\p{Po}\p{Pf}]*(?:[\s\p{Cf}]*(?:\p{Po}|\p{Sc}|[\p{L}.]{1,6}))?[\s\p{Cf}\p{Pe}]*$/u;
  // An ISO currency code before the number may join it with a sign ("CHF-1'234.50"); a code the runtime does not know as
  // a currency ("RE-2611") leaves the text as it is, so an ID stays no number.
  const currencies = new Set(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("currency") : []);
  const isNumber = (text: string) => {
    const code = /^[\s\p{Cf}\p{Pd}\p{Ps}]*(\p{Lu}{3})(?=[\s\p{Cf}\p{Pd}\p{Sm}]*\p{Nd})/u.exec(text);
    return numberLike.test(code && currencies.has(code[1]!) ? text.replace(code[1]!, "") : text);
  };
  const oneLine =
    ".k2-table td .k2-cell-line, .k2-row-time, .k2-row-meta, .k2-cell-value, .k2-chip-text, .k2-digest-date, .k2-fact-value, .k2-sh-count, .k2-gh-count, .k2-tab-count, .k2-ni-count";
  for (const element of Array.from(root.querySelectorAll(oneLine))) {
    if (skipped(element) || !shown(element)) continue;
    const text = words(element.textContent);
    if (!text || !((element.closest("td[data-numeric]") && !element.matches("[data-second]")) || isNumber(text))) continue;
    const cut = hardCut(element);
    const view = seenIn(element);
    let outside = 0;
    for (const run of runs) {
      if (!element.contains(run.node)) continue;
      for (const box of run.boxes) {
        // only what lies in sight: a cell of a row scrolled away is measured when it is scrolled into view
        if (box.bottom < view.top || box.top > view.bottom) continue;
        outside = Math.max(outside, box.right - cut.right, cut.left - box.left);
        // A number that the edge of a scrolling place cuts reads as another number now ("12.345" of "12.345.678,90 €"),
        // although scrolling would show the rest; one that lies whole beyond the edge is simply not in sight.
        const partly = box.right > view.left + 0.5 && box.left < view.right - 0.5;
        if (partly) outside = Math.max(outside, box.right - view.right, view.left - box.left);
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
