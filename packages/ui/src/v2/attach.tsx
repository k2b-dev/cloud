import { resolveUiMessages } from "../intl/messages";
import { keyboardPlatform } from "../intl/shortcut";
import type { Live } from "./attach-live";
import type { ConfirmOptions } from "./overlays";
import type { ToastOptions } from "./toast";
import { resolveWorkspaceMessages } from "./workspace-messages";

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
const sidebarKey = Symbol.for("k2b.ui.v2.toggleSidebar");
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

// The uses waiting for live parts that did not load, of every workspace of the page, and the one notice that says so. "Retry" loads once and runs
// them all; when that fails as well (the page is likely from an older release), the notice offers to reload the page
// and can be closed, which answers every waiting question "no". The notice stands in the top layer of the page, so it
// is above an open dialog, and a lasting layer of @ui-sdk/core's (its layer registry), so a press on it reaches it.
type Waiting = { owner: HTMLElement; run: () => void; drop: () => void };
const pending = new Set<Waiting>();
let notice: HTMLElement | undefined;
let releaseLayer: (() => void) | undefined;
let retried = false;
const button = (text: string, press: () => void) => {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "k2-btn";
  element.dataset.variant = "text";
  const label = element.appendChild(document.createElement("span"));
  label.className = "k2-btn-label";
  label.textContent = text;
  element.addEventListener("click", press);
  return element;
};
const closeNotice = () => {
  releaseLayer?.();
  releaseLayer = undefined;
  notice?.remove();
  notice = undefined;
};
const showNotice = () => {
  if (notice?.dataset.retried === String(retried)) return;
  closeNotice();
  const t = resolveUiMessages();
  const words = resolveWorkspaceMessages();
  // the v2 scope of the workspace, beside the page's other content
  const scope = document.createElement("div");
  scope.className = "k2-ui";
  scope.dataset.k2WsFailed = "";
  scope.dataset.retried = String(retried);
  scope.style.display = "contents";
  const region = scope.appendChild(document.createElement("section"));
  region.className = "k2-toasts";
  region.dataset.k2Part = "Toast";
  region.setAttribute("role", "alert");
  region.popover = "manual";
  const item = region.appendChild(document.createElement("ol")).appendChild(document.createElement("li"));
  item.className = "k2-toast";
  item.dataset.type = "error";
  const text = item.appendChild(document.createElement("span"));
  text.className = "k2-toast-text";
  text.textContent = words.controlsFailed;
  if (!retried)
    item.append(
      button(t.retry, () => {
        retried = true;
        closeNotice();
        const waiting = [...pending];
        pending.clear();
        for (const use of waiting) use.run();
      }),
    );
  else
    item.append(
      button(words.reloadPage, () => window.location.reload()),
      button(t.close, () => {
        closeNotice();
        const waiting = [...pending];
        pending.clear();
        for (const use of waiting) use.drop();
      }),
    );
  document.body.append(scope);
  region.showPopover?.();
  // A layer that stays, as the toaster is: a press on it neither closes an open dialog nor is taken by it. The registry
  // loads with the notice; should it not load either, the notice still shows and is pressed, and a first press on it
  // closes a dialog that closes on a press outside.
  void import("./behavior/layer").then(
    ({ bindPersistentLayer }) => {
      if (notice !== scope) return;
      releaseLayer = bindPersistentLayer(region);
      region.dataset.lasting = "";
    },
    () => {},
  );
  notice = scope;
};
/** Drops the waiting uses of a workspace that goes; the notice goes with the last one. */
const dropWaiting = (owner: HTMLElement) => {
  for (const use of [...pending])
    if (use.owner === owner) {
      pending.delete(use);
      use.drop();
    }
  if (pending.size === 0) closeNotice();
};

/** Where a person types: a shortcut there would take a letter from the text. */
const editable = (target: EventTarget | null) =>
  target instanceof Element &&
  target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]') !== null;

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
  const t = resolveUiMessages();
  const words = resolveWorkspaceMessages();

  // The live parts load once; a load that fails is tried again by the next use, and a use that was waiting for it
  // says so at the bottom of the page with "Retry", which runs it again. Nothing waits in silence.
  let live: Promise<Live> | undefined;
  let stopped = false;
  const load = () => {
    live ??= import("./attach-live").then(
      ({ mountLive }) => {
        if (stopped) throw new Error("detached");
        const parts = mountLive(element, host);
        // from here on the drawer's own trigger answers the button
        toggle?.removeEventListener("click", first);
        stops.push(parts.stop);
        return parts;
      },
      (error: unknown) => {
        live = undefined;
        throw error;
      },
    );
    return live;
  };
  // Questions still waiting when the workspace goes (a navigation during the load) are answered "no".
  const waiting = new Set<(answer: boolean) => void>();
  /** Runs `use` with the live parts, once they are there; until the workspace goes, a failed load offers a retry. */
  const withLive = <T,>(use: (parts: Live) => T | Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const entry: Waiting = {
        owner: element,
        run: () => {
          if (stopped) return reject(new Error("detached"));
          load().then(
            (parts) => resolve(use(parts)),
            () => {
              if (stopped) return reject(new Error("detached"));
              pending.add(entry);
              showNotice();
            },
          );
        },
        drop: () => reject(new Error("closed")),
      };
      entry.run();
    });

  // a press before the drawer has loaded opens it once it is there
  const first = () => void withLive((parts) => parts.openDrawer()).catch(() => {});
  Reflect.set(host, toasterKey, (message: string, toastOptions?: ToastOptions) => {
    const id = `k2-toast-${Date.now().toString(36)}-${++toastCount}`;
    void withLive((parts) => parts.show(message, toastOptions, id)).catch(() => {});
    return id;
  });
  // `Dialog.confirm` asks the first workspace of the page that answers
  Reflect.set(
    element,
    confirmKey,
    (question: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        waiting.add(resolve);
        withLive((parts) => parts.ask(question))
          .then(resolve, () => resolve(false))
          .finally(() => waiting.delete(resolve));
      }),
  );

  if (toggle) {
    toggle.addEventListener("click", first);
    stops.push(() => toggle.removeEventListener("click", first));
    const prefetch = () => void load().catch(() => {});
    listen(toggle, "pointerenter", prefetch);
    listen(toggle, "focus", prefetch);
  }

  // The collapse of the sidebar on a wide screen: its button, Mod+Alt+S, and the state kept by the caller.
  if (collapse && aside) {
    // the button speaks the language of the page, as the server rendered it
    const set = (collapsed: boolean) => {
      element.toggleAttribute("data-collapsed", collapsed);
      collapse.setAttribute("aria-expanded", String(!collapsed));
      collapse.setAttribute("aria-label", collapsed ? t.showSidebar : words.hideSidebar);
      collapse.setAttribute("title", collapsed ? t.showSidebar : words.hideSidebar);
      options.onSidebarCollapsedChange?.(collapsed);
    };
    // Mod+Alt+S and `toggleWorkspaceSidebar`: in a narrow window the sidebar is a drawer, and they open and close it
    const toggleSidebar = (): boolean => {
      if (toggle && toggle.getClientRects().length > 0) void withLive((parts) => parts.toggleDrawer()).catch(() => {});
      else if (collapse.getClientRects().length > 0) set(!element.hasAttribute("data-collapsed"));
      else return false;
      return true;
    };
    Reflect.set(element, sidebarKey, toggleSidebar);
    stops.push(() => Reflect.deleteProperty(element, sidebarKey));
    listen(collapse, "click", () => set(!element.hasAttribute("data-collapsed")));
    listen(document, "keydown", (event) => {
      if (!(event instanceof KeyboardEvent)) return;
      if (event.defaultPrevented || !event.altKey || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.code !== "KeyS") return;
      // AltGr (Ctrl+Alt on Windows) writes letters such as "ś"; typing and composing text is never a shortcut
      // (macOS has no AltGr, and Gecko reports its Option as AltGraph); with Command a field types nothing
      if (
        (keyboardPlatform() !== "apple" && event.getModifierState("AltGraph")) ||
        event.isComposing ||
        (editable(event.target) && !event.metaKey)
      )
        return;
      if (toggleSidebar()) event.preventDefault();
    });
  }

  // A workspace an island renders keeps its grips and folds itself; the server's need them from here.
  if (!element.closest(island)) {
    for (const grip of own<HTMLElement>(element, "[data-k2-grip]")) stops.push(trackGrip(grip));
    for (const button of own<HTMLElement>(element, ".k2-nav [data-fold][aria-controls]")) stops.push(bindFold(button));
  }

  return () => {
    stopped = true;
    dropWaiting(element);
    for (const answer of waiting) answer(false);
    waiting.clear();
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
/**
 * Hides or shows the sidebar of the page's first workspace that has the collapse (`collapsible`), as its button and
 * Mod+Alt+S do: on a wide screen it collapses or expands it, and `onSidebarCollapsedChange` hears the change; where
 * the sidebar is a drawer, it opens or closes the drawer. For a command of the page, such as "Hide navigation" in a
 * search. Returns false when no attached workspace has the collapse or its sidebar shows neither way (the phone).
 */
export const toggleWorkspaceSidebar = (root?: ParentNode): boolean => {
  if (typeof document === "undefined") return false;
  for (const element of (root ?? document).querySelectorAll("[data-k2-workspace]")) {
    const toggle: unknown = Reflect.get(element, sidebarKey);
    if (typeof toggle === "function") return Boolean(toggle());
  }
  return false;
};

export const attachWorkspaces = (options: AttachOptions = {}, root: ParentNode = document): (() => void) => {
  const stops = [...root.querySelectorAll<HTMLElement>("[data-k2-workspace]")]
    .filter((element) => !element.closest(island))
    .map((element) => attachWorkspace(element, options));
  return () => {
    for (const stop of stops) stop();
  };
};
