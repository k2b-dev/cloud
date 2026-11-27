import type { MenuItem } from "./menu";

/**
 * The fold of a bar's end: the buttons of the end that do not fit beside the whole start move into a menu "…" at the
 * end, in their order, the last first. The start keeps its whole width while a button can still fold; only then does
 * it shorten, down to its least (the stylesheet's: the name at its least width, or the open tab and "Mehr"), never to
 * nothing. The primary action, the head's twin of the floating button (`[data-floats]`), a closing ×
 * (`[data-closes]`), a menu, a search and anything that is no button never fold.
 *
 * Where the end already ends with a menu "…" of its own (an icon-only `Menu` that offered itself, see `Menu`), the
 * folded buttons are that menu's first section: no second "…" stands beside it. Otherwise the bar shows its own.
 *
 * The browser measures, the server cannot: one pass reads every watched bar with its parts at their whole width
 * (`data-k2-measuring`, set and taken away again before the browser paints), then marks the buttons that fold
 * (`data-k2-folded`: out of sight, out of the tab order and out of the accessibility tree) and the bar as measured
 * (`data-k2-fitted`). Before that, on the server's page, the start keeps its least and the end cuts what it has no
 * room for; so at load only buttons turn into "…". A bar that fits is never changed. The buttons that stay keep their
 * order, so the keyboard reads the bar as the eye does. Each entry of the menu presses its button (a link entry
 * leads where the link leads), so the button's deed, address and state stay the one truth.
 */

export type FoldShow = (entries: MenuItem[], host: HTMLElement | undefined) => void;

type Watched = {
  bar: HTMLElement;
  show: FoldShow;
  folded: HTMLElement[];
  /** What the menu shows now, as words and states: it is drawn again only when they change. */
  shown: string;
  /** The icon-only menus of the end that can take the folded buttons as their first section. */
  hosts: Set<HTMLElement>;
};

/** The buttons a bar may fold into "…"; the one list for the fold and for `measureV2Layout`. */
export const foldable = '.k2-btn:not([data-variant="primary"], [data-floats], [data-closes], [aria-haspopup], [popover])';
/**
 * What stands after the "…" that takes the folded buttons without folding itself: a closing ×, the primary, a menu
 * of its own (a symbol such as "Ansicht", or words such as "Filter"). A "…" that offers itself is no such menu.
 */
const neverFolds = '[data-variant="primary"], [data-floats], [data-closes], [aria-haspopup]';

/**
 * The parts of an element as laid out in its row: a wrapper of `display: contents` (an island) is looked through; the
 * bar's own "…", a popup (`[popover]`, also while it is open) and whatever stands out of the flow are left out.
 */
const laidOut = (element: Element): HTMLElement[] =>
  [...element.children].flatMap((child) => {
    if (!(child instanceof HTMLElement) || child.classList.contains("k2-bar-fold") || child.hasAttribute("popover")) return [];
    const style = getComputedStyle(child);
    if (style.display === "contents") return laidOut(child);
    return style.position === "absolute" || style.position === "fixed" ? [] : [child];
  });

/** The name a person hears for a button: its own words or label, and what `about` adds to it. */
const nameOf = (control: HTMLElement): string => {
  const own = control.querySelector(":scope > .k2-btn-label")?.textContent?.trim() || control.getAttribute("aria-label") || "";
  const about = (control.getAttribute("aria-labelledby") ?? "")
    .split(/\s+/)
    .filter((id) => id && id !== control.id)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
    .filter(Boolean);
  return [own || control.textContent?.trim() || "", ...about].join(" ");
};

const entryOf = (control: HTMLElement): MenuItem => {
  const pressed = control.getAttribute("aria-pressed");
  // the symbol before the words, not the chevron of `forward` or `menu` after them
  const lead = control.firstElementChild?.matches(".k2-icon") ? control.firstElementChild.getAttribute("data-name") : null;
  // a disabled link is an anchor without an address (`Button`): it stays a link entry, which then leads nowhere
  const href = control instanceof HTMLAnchorElement ? (control.getAttribute("href") ?? "") : null;
  const entry: MenuItem = {
    label: nameOf(control),
    icon: lead ?? undefined,
    disabled: control.matches(':disabled, [aria-disabled="true"], [aria-busy="true"]') || undefined,
    checked: pressed === null ? undefined : pressed === "true",
  };
  // a link stays a link: a click with Ctrl or the middle button opens its page beside, a plain one goes as it goes
  return href !== null ? { ...entry, href, onNavigate: () => control.click() } : { ...entry, onClick: () => control.click() };
};

type Found = { folded: HTMLElement[]; host: HTMLElement | undefined };

/** What one bar folds, read while it is measured: the buttons from the end, until the end fits beside the whole start. */
const measure = (entry: Watched): Found => {
  const { bar } = entry;
  const start = bar.querySelector<HTMLElement>(":scope > .k2-bar-start");
  const end = bar.querySelector<HTMLElement>(":scope > .k2-bar-end");
  if (!end) return { folded: [], host: undefined };
  const style = getComputedStyle(bar);
  // A bar that wraps (a line of things in a narrow column) has the room of its lines; a record's head (`RecordHead`)
  // keeps its own way: its name gives way beside its actions, and on the phone it wraps.
  if (style.flexWrap !== "nowrap" || start?.querySelector(".k2-record-name")) return { folded: [], host: undefined };
  const room = bar.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0);
  const gap = Number.parseFloat(style.columnGap) || 0;
  const endStyle = getComputedStyle(end);
  const endGap = Number.parseFloat(endStyle.columnGap) || 0;
  // the end's room for the rings of its buttons (v2.css: 4 px inside its cut, the one at the far edge outside the bar)
  const rings =
    (Number.parseFloat(endStyle.paddingLeft) || 0) +
    (Number.parseFloat(endStyle.paddingRight) || 0) +
    (Number.parseFloat(endStyle.marginRight) || 0);
  const controls = laidOut(end).filter((control) => control.getClientRects().length > 0);
  const widths = controls.map((control) => control.getBoundingClientRect().width);
  // the end's last "…" menu, after which stand only parts that never fold (a closing ×, the primary, a menu of its
  // own), takes the folded buttons: nothing new stands beside it, and nothing after the ×
  const last = [...controls].reverse().find((control) => entry.hosts.has(control) || !control.matches(neverFolds));
  const host = last && entry.hosts.has(last) ? last : undefined;
  const more = bar.querySelector<HTMLElement>(":scope > .k2-bar-end > .k2-bar-fold .k2-btn");
  // the bar's own "…" is a button of the bar's own height for controls, as square as an icon button
  const moreWidth = host
    ? 0
    : (more?.getBoundingClientRect().width ?? Math.max(0, ...controls.map((control) => control.getBoundingClientRect().height)));
  let used =
    rings +
    (start ? start.getBoundingClientRect().width + gap : 0) +
    widths.reduce((sum, width) => sum + width, 0) +
    endGap * Math.max(0, controls.length - 1);
  const folded: HTMLElement[] = [];
  // not a fraction over: the start would give that fraction, and a tab of it would hide
  for (let index = controls.length - 1; index >= 0 && used > room; index--) {
    const control = controls[index]!;
    if (!control.matches(foldable)) continue;
    folded.unshift(control);
    used -= widths[index]! + endGap;
    if (folded.length === 1 && moreWidth) used += moreWidth + endGap;
  }
  // a fold that gives no room (one icon button into a "…" as wide) is none: the start gives way instead
  const saved =
    folded.reduce((sum, control) => sum + widths[controls.indexOf(control)]! + endGap, 0) - (moreWidth ? moreWidth + endGap : 0);
  if (saved <= 0) return { folded: [], host: undefined };
  return { folded, host: folded.length ? host : undefined };
};

/** Measures the given bars in one pass: all writes, then all reads, then all writes again. */
const fold = (bars: Iterable<Watched>) => {
  const list = [...bars].filter((entry) => entry.bar.isConnected);
  for (const entry of list) entry.bar.setAttribute("data-k2-measuring", "");
  const found = list.map(measure);
  for (const entry of list) entry.bar.removeAttribute("data-k2-measuring");
  list.forEach((entry, index) => {
    const { folded: next, host } = found[index]!;
    const same = next.length === entry.folded.length && next.every((control, at) => control === entry.folded[at]);
    // a button that folds while it has the focus hands it to the "…" that now holds it, once that is drawn
    const focused = next.find((control) => control === document.activeElement && !entry.folded.includes(control));
    if (!same) {
      for (const control of entry.folded) if (!next.includes(control)) control.removeAttribute("data-k2-folded");
      for (const control of next) control.setAttribute("data-k2-folded", "");
      entry.folded = next;
    }
    entry.bar.setAttribute("data-k2-fitted", "");
    // the words or the state of a button may have changed while it stayed folded
    const entries = next.map(entryOf);
    const shown = JSON.stringify([
      host ? 1 : 0,
      entries.map(({ label, icon, disabled, checked, href }) => [label, icon, disabled, checked, href]),
    ]);
    if (shown !== entry.shown) {
      entry.shown = shown;
      entry.show(entries, host);
    }
    if (focused) (host ?? entry.bar.querySelector<HTMLElement>(":scope > .k2-bar-end > .k2-bar-fold .k2-btn"))?.focus();
  });
};

let sizes: ResizeObserver | undefined;
const byElement = new Map<Element, Watched>();
const watched = new Set<Watched>();
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
// a font that arrives late makes words wider without changing what the bar holds
let fonts = false;
const watchFonts = () => {
  if (fonts || typeof document === "undefined" || !document.fonts) return;
  fonts = true;
  document.fonts.addEventListener("loadingdone", () => {
    for (const entry of watched) later(entry);
  });
};

/** The states of a button that its menu entry shows. */
const states = ["disabled", "aria-disabled", "aria-pressed", "aria-label", "aria-busy", "href"];

export type Fold = {
  /** Stops watching and gives every folded button back. */
  stop: () => void;
  /** An icon-only menu of the end offers to take the folded buttons; returns the function that takes the offer back. */
  offer: (trigger: HTMLElement) => () => void;
};

/**
 * Watches one bar from its first moment in the browser: its size, the size of its end, and the words, buttons and
 * states in it.
 */
export const watchFold = (bar: HTMLElement, show: FoldShow): Fold => {
  const entry: Watched = { bar, show, folded: [], shown: "", hosts: new Set() };
  watched.add(entry);
  byElement.set(bar, entry);
  watchFonts();
  sizes ??= new ResizeObserver((changes) => {
    for (const change of changes) {
      const found = byElement.get(change.target);
      if (found) later(found);
    }
  });
  sizes.observe(bar);
  const ends = () => bar.querySelector(":scope > .k2-bar-end");
  let end = ends();
  if (end) {
    byElement.set(end, entry);
    sizes.observe(end);
  }
  // a button that comes or goes, words or a state that change, or an end that appears change what fits
  const content = new MutationObserver(() => {
    const now = ends();
    if (now !== end) {
      if (end) {
        sizes?.unobserve(end);
        byElement.delete(end);
      }
      end = now;
      if (end) {
        byElement.set(end, entry);
        sizes?.observe(end);
      }
    }
    later(entry);
  });
  content.observe(bar, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: states });
  fold([entry]);
  return {
    stop: () => {
      content.disconnect();
      sizes?.unobserve(bar);
      if (end) sizes?.unobserve(end);
      byElement.delete(bar);
      if (end) byElement.delete(end);
      watched.delete(entry);
      due.delete(entry);
      for (const control of entry.folded) control.removeAttribute("data-k2-folded");
    },
    offer: (trigger) => {
      entry.hosts.add(trigger);
      later(entry);
      return () => {
        entry.hosts.delete(trigger);
        later(entry);
      };
    },
  };
};
