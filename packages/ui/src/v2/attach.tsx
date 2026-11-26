import { resolveUiMessages } from "../intl/messages";
import type { Live } from "./attach-live";
import type { ConfirmOptions } from "./overlays";
import type { ToastOptions } from "./toast";

// A `Workspace` renders on the server as plain markup: the frame, its columns, heads and bars need no script. What
// needs the browser comes from `attachWorkspace`: the drawer of the sidebar, the collapse of the sidebar, the alert
// dialog of `Dialog.confirm`, the toaster of `useToast`, the grips in the middle of their lines and the folds of the
// `Nav`. A Workspace inside an island attaches itself when it mounts; `attachWorkspaces` attaches every other one.

export type AttachOptions = {
  /**
   * The person collapsed or expanded the sidebar (its button or Mod+Alt+S): keep it, such as in a cookie, so the next
   * page renders it the same way from the server (`Workspace` `sidebarCollapsed`).
   */
  onSidebarCollapsedChange?: (collapsed: boolean) => void;
};

const attached = Symbol.for("k2b.ui.v2.workspace.attached");
// the keys under which the page finds its asking and toasting functions (`Dialog.confirm`, `useToast`)
const confirmKey = Symbol.for("k2b.ui.v2.confirm");
const toasterKey = Symbol.for("k2b.ui.v2.toaster");
const island = "solid-island, solid-client";

// ── Grips ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Keeps every grip in the vertical middle of the part of its line that is in sight (mockup resize.js): a line taller
 * than its scroller, such as the one beside a record's info column, would otherwise hold its grip below the window.
 * Until the page is live the grip stands in the middle of the line, at most half a window down (CSS). One frame
 * measures every grip first and then moves them, so several grips cost one layout.
 */
const grips = new Map<HTMLElement, HTMLElement[]>();
let frame = 0;
let sizes: ResizeObserver | undefined;

/** The middle of the part of the grip's line in sight, from the line's top; nothing when the line is out of sight. */
const middleOf = (grip: HTMLElement, clips: readonly HTMLElement[]) => {
  const seam = grip.parentElement;
  if (!seam) return undefined;
  const line = seam.getBoundingClientRect();
  let top = Math.max(line.top, 0);
  let bottom = Math.min(line.bottom, window.innerHeight);
  for (const clip of clips) {
    const box = clip.getBoundingClientRect();
    top = Math.max(top, box.top);
    bottom = Math.min(bottom, box.bottom);
  }
  const half = grip.offsetHeight / 2;
  // a line out of sight keeps its grip where it was
  return bottom - top < grip.offsetHeight ? undefined : Math.round((top + bottom) / 2 - line.top - half);
};
const placeAll = () => {
  frame = 0;
  const places = [...grips].map(([grip, clips]) => [grip, middleOf(grip, clips)] as const);
  for (const [grip, top] of places) if (top !== undefined) grip.style.setProperty("--k2-grip-top", `${top}px`);
};
const schedule = () => {
  frame ||= requestAnimationFrame(placeAll);
};

/** Keeps one grip in the middle of its line in sight until the returned function stops it (internal). */
export const trackGrip = (grip: HTMLElement): (() => void) => {
  const seam = grip.parentElement;
  // the boxes that clip the line: every scroller above it (they stay while the grip lives)
  const clips: HTMLElement[] = [];
  for (let up = seam?.parentElement; up; up = up.parentElement)
    if (/^(auto|scroll|hidden|clip)$/.test(getComputedStyle(up).overflowY)) clips.push(up);
  if (!grips.size) {
    sizes = new ResizeObserver(schedule);
    // a scroll anywhere above moves the part in sight; capture hears the scrollers, which do not bubble it
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule, { passive: true });
  }
  grips.set(grip, clips);
  if (seam) sizes?.observe(seam);
  schedule();
  return () => {
    if (!grips.delete(grip)) return;
    if (seam) sizes?.unobserve(seam);
    if (grips.size) return;
    cancelAnimationFrame(frame);
    frame = 0;
    sizes?.disconnect();
    sizes = undefined;
    document.removeEventListener("scroll", schedule, { capture: true });
    window.removeEventListener("resize", schedule);
  };
};

// ── Folds of the Nav ─────────────────────────────────────────────────────────────────────────────────────────────

/** A folding entry of a server's `Nav`: its button shows or hides the entries it controls. */
const bindFold = (button: HTMLElement): (() => void) => {
  const toggle = () => {
    const target = document.getElementById(button.getAttribute("aria-controls") ?? "");
    if (!target) return;
    const open = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(open));
    target.hidden = !open;
    // its chevron, as `Icon` names it
    const icon = button.querySelector(":scope > .k2-icon");
    icon?.classList.replace(open ? "ti-chevron-right" : "ti-chevron-down", open ? "ti-chevron-down" : "ti-chevron-right");
    icon?.setAttribute("data-name", open ? "chevron-down" : "chevron-right");
  };
  button.addEventListener("click", toggle);
  return () => button.removeEventListener("click", toggle);
};

// ── The workspace ────────────────────────────────────────────────────────────────────────────────────────────────

/** What belongs to this workspace itself: not to an island in it, nor to a workspace inside it. */
const own = <E extends Element>(element: HTMLElement, selector: string): E[] =>
  [...element.querySelectorAll<E>(selector)].filter((found) => found.closest(`${island}, [data-k2-workspace]`) === element);

let toastCount = 0;

/**
 * Brings one Workspace the server rendered alive (see the top of this module); returns the function that stops it.
 * Attaching it again does nothing. A Workspace inside an island calls it itself when it mounts.
 *
 * What it does at once needs no library: the grips, the folds of the `Nav`, the collapse of the sidebar and its keys.
 * The drawer, `Dialog.confirm` and `useToast` need @ui-sdk/core, which loads on their first use (a press on the
 * drawer's button, a question, a toast) and is fetched ahead when the pointer or the focus reaches the button.
 */
export const attachWorkspace = (element: HTMLElement, options: AttachOptions = {}): (() => void) => {
  if (Reflect.get(element, attached)) return () => {};
  Reflect.set(element, attached, true);
  const stops: (() => void)[] = [];
  const listen = (target: EventTarget, type: string, run: (event: Event) => void) => {
    target.addEventListener(type, run);
    stops.push(() => target.removeEventListener(type, run));
  };

  // The live parts stand at the end of the workspace, in an element without a box of its own. It is the page's
  // toaster from the start: `useToast` finds it and shows its first toast once the toaster has loaded.
  const host = document.createElement("div");
  host.dataset.k2WsLive = "";
  host.dataset.k2Toaster = "";
  host.style.display = "contents";
  element.append(host);
  const head = element.querySelector<HTMLElement>(':scope > .k2-ws-main > [data-slot="head"]');
  const toggle = head?.querySelector<HTMLElement>(":scope > .k2-ws-toggle");
  const collapse = head?.querySelector<HTMLElement>(":scope > .k2-ws-collapse");
  const aside = element.querySelector<HTMLElement>(":scope > .k2-ws-side");
  // a press before the drawer has loaded opens it once it is there
  const first = () => void load().then((parts) => parts.openDrawer());
  let live: Promise<Live> | undefined;
  let stopped = false;
  const load = () => {
    live ??= import("./attach-live").then(({ mountLive }) => {
      const parts = mountLive(element, host);
      // from here on the drawer's own trigger answers the button
      toggle?.removeEventListener("click", first);
      if (stopped) parts.stop();
      else stops.push(parts.stop);
      return parts;
    });
    return live;
  };
  Reflect.set(host, toasterKey, (message: string, toastOptions?: ToastOptions) => {
    const id = `k2-toast-${Date.now().toString(36)}-${++toastCount}`;
    void load().then((parts) => parts.show(message, toastOptions, id));
    return id;
  });
  // `Dialog.confirm` asks the first workspace of the page that answers
  Reflect.set(element, confirmKey, (question: ConfirmOptions) => load().then((parts) => parts.ask(question)));

  if (toggle) {
    toggle.addEventListener("click", first);
    stops.push(() => toggle.removeEventListener("click", first));
    listen(toggle, "pointerenter", () => void load());
    listen(toggle, "focus", () => void load());
  }

  // The collapse of the sidebar on a wide screen: its button, Mod+Alt+S, and the state kept by the caller.
  if (collapse && aside) {
    // the button speaks the language of the page, as the server rendered it
    const t = resolveUiMessages();
    const set = (collapsed: boolean) => {
      element.toggleAttribute("data-collapsed", collapsed);
      collapse.setAttribute("aria-expanded", String(!collapsed));
      collapse.setAttribute("aria-label", collapsed ? t.showSidebar : t.hideSidebar);
      collapse.setAttribute("title", collapsed ? t.showSidebar : t.hideSidebar);
      options.onSidebarCollapsedChange?.(collapsed);
    };
    listen(collapse, "click", () => set(!element.hasAttribute("data-collapsed")));
    listen(document, "keydown", (event) => {
      if (!(event instanceof KeyboardEvent)) return;
      if (event.defaultPrevented || !event.altKey || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.code !== "KeyS") return;
      // in a narrow window the sidebar is a drawer, and the same keys open and close it
      if (toggle && toggle.getClientRects().length > 0) void load().then((parts) => parts.toggleDrawer());
      else if (collapse.getClientRects().length > 0) set(!element.hasAttribute("data-collapsed"));
      else return;
      event.preventDefault();
    });
  }

  // A workspace an island renders keeps its grips and folds itself; the server's need them from here.
  if (!element.closest(island)) {
    for (const grip of own<HTMLElement>(element, "[data-k2-grip]")) stops.push(trackGrip(grip));
    for (const button of own<HTMLElement>(element, ".k2-nav [data-fold][aria-controls]")) stops.push(bindFold(button));
  }

  return () => {
    stopped = true;
    for (const stop of stops.splice(0).reverse()) stop();
    host.remove();
    Reflect.deleteProperty(element, confirmKey);
    Reflect.deleteProperty(element, attached);
  };
};

/**
 * Attaches every Workspace of the page that is not inside an island (those attach themselves). The frame entry of a
 * page calls it once, after the page is there: in Cloud the `ui: "v2"` layout does; a standalone app writes a
 * `.client.tsx` with `onMount(() => onCleanup(attachWorkspaces()))` and renders it once on the page.
 */
export const attachWorkspaces = (options: AttachOptions = {}, root: ParentNode = document): (() => void) => {
  const stops = [...root.querySelectorAll<HTMLElement>("[data-k2-workspace]")]
    .filter((element) => !element.closest(island))
    .map((element) => attachWorkspace(element, options));
  return () => {
    for (const stop of stops) stop();
  };
};
