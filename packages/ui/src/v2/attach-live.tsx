import { createRenderEffect, createRoot, createSignal, onCleanup, Show } from "solid-js";
import { render } from "solid-js/web";
import { useUiMessages } from "../intl/messages";
import { useDrawer } from "./behavior/overlays";
import { type GripOptions, useGrip } from "./behavior/resize";
import { custom } from "./marks";
import { ConfirmDialog, type ConfirmOptions } from "./overlays";
import { type ToastOptions, Toasts } from "./toast";

// The parts of an attached Workspace that need @ui-sdk/core: the sidebar's drawer, the alert dialog of
// `Dialog.confirm` and the toaster. `attachWorkspace` loads this module on their first use, so a page whose person
// never opens the drawer, asks nothing and is told nothing loads none of it.

const confirmKey = Symbol.for("k2b.ui.v2.confirm");
const toasterKey = Symbol.for("k2b.ui.v2.toaster");

/** A grip the server rendered, alive: what a press or a key that came before it was do now, and its end. */
export type GripHandle = { press: (event: PointerEvent) => void; key: (event: KeyboardEvent) => void; stop: () => void };

export type Live = {
  /** Brings a grip of the server's workspace alive; nothing when the page holds no column for it. */
  bindGrip: (grip: HTMLElement) => GripHandle | undefined;
  /** Opens the drawer, or closes it when it is open. */
  toggleDrawer: () => void;
  openDrawer: () => void;
  ask: (options: ConfirmOptions) => Promise<boolean>;
  show: (message: string, options: ToastOptions | undefined, id: string) => void;
  stop: () => void;
};

const Parts = (props: {
  element: HTMLElement;
  host: HTMLElement;
  toggle?: HTMLElement;
  aside?: HTMLElement;
  drawer: (set: (open: (was: boolean) => boolean) => void) => void;
}) => {
  const t = useUiMessages();
  const element = props.element;
  const toggle = props.toggle;
  const aside = props.aside;
  const [open, setOpen] = createSignal(false);
  const drawer = useDrawer(() => ({ open: open(), onOpenChange: setOpen, side: "start" }));
  if (toggle) onCleanup(drawer.bindTrigger(toggle));
  props.drawer((next) => setOpen(next(open())));

  // The drawer holds the sidebar's one stable box while it is open (the column is hidden then) and gives it back when it
  // closes: what Solid renders in it keeps rendering there, islands in it stay alive, and its scroll position and open
  // folds stay as they were. A sidebar that leaves the page while the drawer is open (its Workspace renders none) closes
  // the drawer and goes with it.
  const body = aside?.querySelector<HTMLElement>(":scope > .k2-ws-side-body") ?? undefined;
  let panel: HTMLElement | undefined;
  let refocus = false;
  const fill = (popup: HTMLElement) => {
    panel = popup;
    if (!aside || !body) return;
    popup.append(body);
    const gone = new MutationObserver(() => {
      if (!aside.isConnected) setOpen(false);
    });
    gone.observe(element, { childList: true });
    onCleanup(() => {
      gone.disconnect();
      if (!aside.isConnected) return;
      aside.append(body);
      // the drawer closed because the window grew: the focus it held goes to the column's current entry
      if (!refocus) return;
      refocus = false;
      requestAnimationFrame(() => aside.querySelector<HTMLElement>('[aria-current="page"], a[href], button:not([disabled])')?.focus());
    });
  };

  // When the window grows while the drawer is open, the sidebar is a column again and the drawer closes. Its button is
  // gone then, so a focus inside the drawer goes to the column's current entry once the entries are back there.
  const sizes = new ResizeObserver(() => {
    if (!open() || !toggle || toggle.getClientRects().length > 0) return;
    refocus = panel?.contains(document.activeElement) ?? false;
    setOpen(false);
  });
  sizes.observe(element);
  onCleanup(() => sizes.disconnect());

  // Picking an entry (a link, a button that opens no disclosure, menu or dialog) closes the drawer; the page it opens is
  // what matters.
  const pick = (event: MouseEvent) => {
    if (event.target instanceof Element && event.target.closest("a[href], button:not([aria-expanded]):not([aria-haspopup])"))
      setOpen(false);
  };

  return (
    <>
      <Show when={aside}>
        <drawer.Popup
          ref={fill}
          class="k2-drawer"
          data-k2-part="Drawer"
          aria-label={t().sidebar}
          style={custom({ "--k2-drawer-w": element.style.getPropertyValue("--k2-ws-side") || undefined })}
          backdrop={{ class: "k2-backdrop" }}
          onClick={pick}
        />
      </Show>
      {/* it answers on the live host; the workspace keeps the asking function the page finds (`attachWorkspace`) */}
      <ConfirmDialog host={() => props.host} />
      <Toasts />
    </>
  );
};

// ── Grips ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Where a grip the server rendered moves its column: the width it reads and writes in the page, and how the column
 * measures beside the others. The same as the grips of an island (`Seam` in layout.tsx, the column grip in
 * content.tsx), read from the page instead of from props.
 */
type GripPlace = Pick<GripOptions, "measure" | "observe"> & { value: () => number; write: (px: number) => void; direction: 1 | -1 };

const pixels = (value: string | null | undefined) => Number.parseFloat(value ?? "") || 0;
/** How much `element` can give: its rendered width above its own minimum. */
const slackOf = (element: Element) =>
  Math.max(0, element.getBoundingClientRect().width - (Number.parseFloat(getComputedStyle(element).minWidth) || 0));
/** A width the page keeps in a custom property of `element`. */
const property = (element: HTMLElement, name: string) => ({
  value: () => pixels(element.style.getPropertyValue(name)),
  write: (px: number) => element.style.setProperty(name, `${px}px`),
});

const placeOf = (grip: HTMLElement): GripPlace | undefined => {
  // a table's column grip, at the start of a column head: it moves the column before it, whose <col> holds its width
  if (grip.classList.contains("k2-cgrip")) {
    const cell = grip.parentElement;
    const head = cell?.previousElementSibling;
    const index = head && cell?.parentElement ? [...cell.parentElement.children].indexOf(head) : -1;
    const col = grip.closest("table")?.querySelector(":scope > colgroup")?.children[index];
    const scroller = grip.closest(".k2-table-scroll");
    if (!(col instanceof HTMLElement) || !head || !scroller) return undefined;
    return {
      value: () => pixels(col.style.width),
      write: (px) => {
        col.style.width = `${px}px`;
      },
      direction: 1,
      // at most the table's visible width; the table scrolls sideways when its columns need more
      measure: () => {
        const now = head.getBoundingClientRect().width;
        return now ? { now, max: scroller.clientWidth } : undefined;
      },
      observe: () => [scroller, ...(cell?.parentElement?.children ?? [])],
    };
  }
  const seam = grip.parentElement;
  const row = seam?.parentElement;
  if (!seam || !row) return undefined;
  const observe = () => [row, ...row.children];
  const before = seam.previousElementSibling;
  const after = seam.nextElementSibling;
  // the sidebar's grip: it leaves every column its minimum (the room the workspace names)
  if (before instanceof HTMLElement && before.classList.contains("k2-ws-side"))
    return {
      ...property(row, "--k2-ws-side"),
      direction: 1,
      measure: () => {
        const now = before.getBoundingClientRect().width;
        return now ? { now, max: row.clientWidth - pixels(row.dataset.k2Room) + pixels(grip.dataset.reset) } : undefined;
      },
      observe,
    };
  // a seam of a split: the pane on its right moves it if it has a width, else the pane on its left
  const moving = after?.matches(".k2-pane[data-width]") ? after : before?.matches(".k2-pane[data-width]") ? before : undefined;
  if (!(moving instanceof HTMLElement)) return undefined;
  return {
    ...property(moving, "--k2-pane-w"),
    direction: moving === after ? -1 : 1,
    measure: () => {
      const rendered = moving.getBoundingClientRect().width;
      if (!rendered) return undefined;
      // a fixed pane after a line includes it in its width (v2.css)
      const now = rendered + (moving.previousElementSibling?.classList.contains("k2-seam") ? 1 : 0);
      // the flexible panes beside it give way down to their minimum (a pane with a width keeps it)
      let slack = 0;
      for (const other of row.children) if (other.matches(".k2-pane:not([data-width])")) slack += slackOf(other);
      return { now, max: now + slack };
    },
    observe,
  };
};

/** A grip of the server's markup with the behaviour of an island's (`useGrip`): its values follow on the element. */
const bindGrip = (grip: HTMLElement): GripHandle | undefined => {
  const place = placeOf(grip);
  if (!place) return undefined;
  return createRoot((dispose) => {
    const [value, setValue] = createSignal(place.value());
    const handle = useGrip({
      label: () => grip.getAttribute("aria-label") ?? "",
      value,
      onChange: (px) => {
        setValue(px);
        place.write(px);
      },
      min: () => pixels(grip.getAttribute("aria-valuemin")),
      reset: () => pixels(grip.dataset.reset),
      direction: () => place.direction,
      measure: place.measure,
      observe: place.observe,
    });
    handle.ref(grip);
    const attribute = (name: string, read: () => string | number | undefined) =>
      createRenderEffect(() => {
        const next = read();
        if (next === undefined) grip.removeAttribute(name);
        else grip.setAttribute(name, String(next));
      });
    attribute("aria-valuenow", () => handle["aria-valuenow"]);
    attribute("aria-valuemax", () => handle["aria-valuemax"]);
    attribute("aria-valuetext", () => handle["aria-valuetext"]);
    attribute("data-dragging", () => handle["data-dragging"]);
    grip.addEventListener("pointerdown", handle.onPointerDown);
    grip.addEventListener("keydown", handle.onKeyDown);
    onCleanup(() => {
      grip.removeEventListener("pointerdown", handle.onPointerDown);
      grip.removeEventListener("keydown", handle.onKeyDown);
    });
    return { press: handle.onPointerDown, key: handle.onKeyDown, stop: dispose };
  });
};

/** Renders the live parts of one workspace into `host`, at the workspace's end (internal; see `attachWorkspace`). */
export const mountLive = (element: HTMLElement, host: HTMLElement): Live => {
  const toggle = element.querySelector<HTMLElement>(':scope > .k2-ws-main > [data-slot="head"] > .k2-ws-toggle') ?? undefined;
  const aside = element.querySelector<HTMLElement>(":scope > .k2-ws-side") ?? undefined;
  let setDrawer: (next: (was: boolean) => boolean) => void = () => {};
  const stop = render(
    () => <Parts element={element} host={host} toggle={toggle} aside={aside} drawer={(set) => (setDrawer = set)} />,
    host,
  );
  const region = host.querySelector("[data-k2-toaster]");
  return {
    bindGrip,
    toggleDrawer: () => setDrawer((was) => !was),
    openDrawer: () => setDrawer(() => true),
    // a question or a toast after `stop` finds no dialog or toaster: it is not asked (false) and not shown
    ask: (options) => {
      const ask: unknown = Reflect.get(host, confirmKey);
      return typeof ask === "function" ? Promise.resolve(Reflect.apply(ask, undefined, [options])).then(Boolean) : Promise.resolve(false);
    },
    show: (message, options, id) => {
      const show: unknown = region ? Reflect.get(region, toasterKey) : undefined;
      if (typeof show === "function") Reflect.apply(show, undefined, [message, options, id]);
    },
    stop,
  };
};
