import type { MenuItem } from "./menu";

/**
 * The fold of a bar's end: the controls of the end that do not fit move into the menu "…" at its end, in their order,
 * the last first. The start gives way first, as far as it can: its words and buttons shorten with "…" to nothing, tabs
 * hide down to the open one and their "Mehr". What still does not fit beside that least folds. The primary action, the
 * head's twin of the floating button (`[data-floats]`), a menu, a search and anything that is no button never fold.
 *
 * The browser measures, the server cannot: one pass reads every watched bar with its end at its whole width and its
 * start at its least (`data-k2-measuring`, set and taken away again before the browser paints), then marks the
 * controls that fold (`data-k2-folded`: out of sight, out of the tab order and out of the accessibility tree). Before
 * the page is alive, an end that does not fit stands whole and the start gives way. A bar that fits is never
 * changed, on the server's page or after it comes alive; the controls that stay keep their order, so the keyboard
 * reads the bar as the eye does, and "…" comes last. Each entry of the menu presses its control, so the control's
 * own deed, address and state stay the one truth.
 */

type Watched = {
  bar: HTMLElement;
  show: (entries: MenuItem[]) => void;
  folded: HTMLElement[];
  /** What the menu shows now, as words: it is drawn again only when they change. */
  shown: string;
};

const foldable = '.k2-btn:not([data-variant="primary"], [data-floats], [aria-haspopup], [popover])';

/** The children of an element as laid out: a wrapper of `display: contents` (an island) is looked through; the fold
 * itself is left out. */
const laidOut = (element: Element): HTMLElement[] =>
  [...element.children].flatMap((child) =>
    !(child instanceof HTMLElement) || child.classList.contains("k2-bar-fold")
      ? []
      : getComputedStyle(child).display === "contents"
        ? laidOut(child)
        : [child],
  );

const entryOf = (control: HTMLElement): MenuItem => {
  const words = control.querySelector(":scope > .k2-btn-label")?.textContent?.trim();
  const pressed = control.getAttribute("aria-pressed");
  return {
    label: words || control.getAttribute("aria-label") || control.textContent?.trim() || "",
    icon: control.querySelector(":scope > .k2-icon")?.getAttribute("data-name") ?? undefined,
    disabled: control.matches(':disabled, [aria-disabled="true"]') || undefined,
    checked: pressed === null ? undefined : pressed === "true",
    onClick: () => control.click(),
  };
};

/** What one bar folds, read while it is measured: the controls from the end, until the end fits beside the start's least. */
const measure = (bar: HTMLElement): HTMLElement[] => {
  const start = bar.querySelector<HTMLElement>(":scope > .k2-bar-start");
  const end = bar.querySelector<HTMLElement>(":scope > .k2-bar-end");
  if (!end) return [];
  const style = getComputedStyle(bar);
  const room = bar.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0);
  const gap = Number.parseFloat(style.columnGap) || 0;
  const endGap = Number.parseFloat(getComputedStyle(end).columnGap) || 0;
  const more = end.querySelector<HTMLElement>(":scope > .k2-bar-fold .k2-btn");
  const controls = laidOut(end).filter((control) => control.getClientRects().length > 0);
  const widths = controls.map((control) => control.getBoundingClientRect().width);
  // "…" is a button of the bar's own height for controls, as square as an icon button
  const moreWidth =
    more?.getBoundingClientRect().width ?? Math.max(0, ...controls.map((control) => control.getBoundingClientRect().height));
  // the least the start gives way to; nothing where only words and buttons stand in it
  const startWidth = start?.getBoundingClientRect().width ?? 0;
  let used =
    startWidth +
    (startWidth > 0 && controls.length ? gap : 0) +
    widths.reduce((sum, width) => sum + width, 0) +
    endGap * Math.max(0, controls.length - 1);
  const folded: HTMLElement[] = [];
  for (let index = controls.length - 1; index >= 0 && used > room + 0.5; index--) {
    const control = controls[index]!;
    if (!control.matches(foldable)) continue;
    folded.unshift(control);
    used -= widths[index]! + endGap;
    if (folded.length === 1) used += moreWidth + endGap;
  }
  return folded;
};

/** Measures the given bars in one pass: all writes, then all reads, then all writes again. */
const fold = (bars: Iterable<Watched>) => {
  const list = [...bars].filter((entry) => entry.bar.isConnected);
  for (const entry of list) entry.bar.setAttribute("data-k2-measuring", "");
  const found = list.map((entry) => measure(entry.bar));
  for (const entry of list) entry.bar.removeAttribute("data-k2-measuring");
  list.forEach((entry, index) => {
    const next = found[index]!;
    const same = next.length === entry.folded.length && next.every((control, at) => control === entry.folded[at]);
    if (!same) {
      for (const control of entry.folded) if (!next.includes(control)) control.removeAttribute("data-k2-folded");
      for (const control of next) control.setAttribute("data-k2-folded", "");
      entry.folded = next;
    }
    // the words or the state of a control may have changed while it stayed folded
    const entries = next.map(entryOf);
    const shown = JSON.stringify(entries.map(({ label, icon, disabled, checked }) => [label, icon, disabled, checked]));
    if (shown !== entry.shown) {
      entry.shown = shown;
      entry.show(entries);
    }
  });
};

let sizes: ResizeObserver | undefined;
const byBar = new Map<Element, Watched>();
// The bars to measure in the next frame: once per frame, never inside an observer's own turn (WebKit reports a change
// there as a resize loop, as for `Tabs`); the next frame measures what the fold changed.
const due = new Set<Watched>();
const later = (entry: Watched) => {
  if (due.size === 0)
    requestAnimationFrame(() => {
      const list = [...due];
      due.clear();
      fold(list);
    });
  due.add(entry);
};

/**
 * Watches one bar from its first moment in the browser: its size and the words and controls in it. Returns the
 * function that stops watching.
 */
export const watchFold = (bar: HTMLElement, show: (entries: MenuItem[]) => void): (() => void) => {
  const entry: Watched = { bar, show, folded: [], shown: "[]" };
  byBar.set(bar, entry);
  fold([entry]);
  sizes ??= new ResizeObserver((changes) => {
    for (const change of changes) {
      const found = byBar.get(change.target);
      if (found) later(found);
    }
  });
  sizes.observe(bar);
  // a control that comes or goes, or words that change, change what fits without changing the bar's size
  const content = new MutationObserver(() => later(entry));
  content.observe(bar, { childList: true, characterData: true, subtree: true });
  return () => {
    content.disconnect();
    sizes?.unobserve(bar);
    byBar.delete(bar);
    due.delete(entry);
    for (const control of entry.folded) control.removeAttribute("data-k2-folded");
  };
};
