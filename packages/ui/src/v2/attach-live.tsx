import { createSignal, onCleanup, Show } from "solid-js";
import { render } from "solid-js/web";
import { useUiMessages } from "../intl/messages";
import { useDrawer } from "./behavior/overlays";
import { custom } from "./marks";
import { ConfirmDialog, type ConfirmOptions } from "./overlays";
import { type ToastOptions, Toasts } from "./toast";

// The parts of an attached Workspace that need @ui-sdk/core: the sidebar's drawer, the alert dialog of
// `Dialog.confirm` and the toaster. `attachWorkspace` loads this module on their first use, so a page whose person
// never opens the drawer, asks nothing and is told nothing loads none of it.

const confirmKey = Symbol.for("k2b.ui.v2.confirm");
const toasterKey = Symbol.for("k2b.ui.v2.toaster");

export type Live = {
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

  // The drawer holds the sidebar's own nodes while it is open (the column is hidden then) and gives them back when it
  // closes: islands in it stay alive, and its scroll position and open folds stay as they were.
  let panel: HTMLElement | undefined;
  let refocus = false;
  const fill = (popup: HTMLElement) => {
    panel = popup;
    if (!aside) return;
    popup.append(...aside.childNodes);
    onCleanup(() => {
      aside.append(...popup.childNodes);
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
    toggleDrawer: () => setDrawer((was) => !was),
    openDrawer: () => setDrawer(() => true),
    ask: (options) => Promise.resolve(Reflect.apply(Reflect.get(host, confirmKey), undefined, [options])).then(Boolean),
    show: (message, options, id) => {
      if (region) Reflect.apply(Reflect.get(region, toasterKey), undefined, [message, options, id]);
    },
    stop,
  };
};
