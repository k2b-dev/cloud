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
    for (let ancestor = element.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      const clip = ancestor.getBoundingClientRect();
      const clipped = style.clipPath !== "none" && style.clipPath !== "";
      if (style.overflowX !== "visible" || clipped) {
        box.left = Math.max(box.left, clip.left);
        box.right = Math.min(box.right, clip.right);
      }
      if (style.overflowY !== "visible" || clipped) {
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
      problems.push(`${name} leaves the head (${round(box.left)}..${round(box.right)} of ${round(headBox.left)}..${round(headBox.right)})`);
  for (const [index, a] of controls.entries())
    for (const b of controls.slice(index + 1)) {
      const width = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
      const height = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
      if (width > tolerance && height > tolerance) problems.push(`${a.name} overlaps ${b.name} by ${round(width)}x${round(height)}`);
    }
  return { head: { width: headBox.width, height: headBox.height }, controls: controls.map((control) => control.name), problems };
}
