import { onCleanup, Show } from "solid-js";
import { isServer, render } from "solid-js/web";
import { type ToasterParts, type ToastKind, useToaster } from "./behavior/toast";
import { Icon } from "./marks";
import { type OverlayMessages, useOverlayMessages } from "./overlay-messages";

export type ToastOptions = {
  /** Takes the deed back: the toast offers "Undo" and runs this when pressed. */
  undo?: () => unknown;
  /** `ok` for a deed that worked, `bad` for one that failed (announced at once). Without it the toast only reports. */
  status?: "ok" | "bad";
};

/** Shows a toast; returns its id. */
export type ShowToast = (message: string, options?: ToastOptions) => string;

/** The sign of a toast that reports a deed that worked or failed. */
const statusIcon = (type: ToastKind) =>
  type === "success"
    ? ({ name: "circle-check", tone: "ok" } as const)
    : type === "error"
      ? ({ name: "alert-triangle", tone: "bad" } as const)
      : undefined;

/**
 * Core keeps the region in the top layer as an open popover all the time, so toasts stand above any dialog. An empty
 * open popover would take Escape from the page, though: a page that lets an open popover answer Escape first (Mail
 * closing its reader) would never get it. So the region is open only while it shows a toast: opening an empty region
 * is cancelled, the first toast opens it, the last one leaving closes it. Core's own raising re-opens only regions that
 * are open, so it never opens an empty one.
 */
const openWhileShowing = (region: HTMLElement) => {
  if (typeof MutationObserver === "undefined") return;
  const showing = () => region.querySelector('[data-slot="toast"]') !== null;
  region.addEventListener("beforetoggle", (event) => {
    if ("newState" in event && event.newState === "open" && !showing()) event.preventDefault();
  });
  const sync = () => {
    if (!region.isConnected || !region.hasAttribute("popover")) return;
    const open = region.matches(":popover-open");
    try {
      if (showing() && !open) region.showPopover();
      else if (!showing() && open) region.hidePopover();
    } catch {
      // a region that left the page in between has nothing to show
    }
  };
  new MutationObserver(sync).observe(region, { childList: true, subtree: true, attributes: true, attributeFilter: ["popover"] });
};

/** The toasts of one owner at the bottom in the middle, newest on top, at most three; nothing moves when one comes. */
const ToastRegion = (props: { parts: ToasterParts; host?: (element: HTMLElement) => void }) => {
  const { Region, Toast, Title, Action } = props.parts;
  return (
    <Region
      class="k2-toasts"
      data-k2-part="Toast"
      data-k2-toaster={props.host ? "" : undefined}
      ref={(element: HTMLElement) => {
        props.host?.(element);
        openWhileShowing(element);
      }}
      side="bottom"
      align="center"
      maxVisible={3}
      toast={(view) => (
        <Toast id={view().id} class="k2-toast" data-type={view().type}>
          <Show when={statusIcon(view().type)}>{(icon) => <Icon name={icon().name} tone={icon().tone} />}</Show>
          <Title id={view().id} class="k2-toast-text">
            {view().title}
          </Title>
          <Show when={view().actionLabel}>
            {(label) => (
              <Action id={view().id} class="k2-btn" data-variant="text">
                <span class="k2-btn-label">{label()}</span>
              </Action>
            )}
          </Show>
        </Toast>
      )}
    />
  );
};

const showOf =
  (parts: ToasterParts, t: () => OverlayMessages): ShowToast =>
  (message, options = {}) => {
    const undo = options.undo;
    return parts.toaster.show({
      title: message,
      type: options.status === "bad" ? "error" : options.status === "ok" ? "success" : "default",
      action: undo && { label: t().undo, onAction: undo },
    });
  };

/**
 * The page's toaster is found through the page, not through a module: every island bundles its own copy of
 * `@k2b/ui`, and a module-level registry would also be shared by all requests on a server. `Toasts` puts its `show`
 * on its region's element under this key.
 */
const hostKey = Symbol.for("k2b.ui.v2.toaster");

const pageToaster = (): ShowToast | undefined => {
  const host = document.querySelector("[data-k2-toaster]");
  const show: unknown = host ? Reflect.get(host, hostKey) : undefined;
  if (typeof show !== "function") return undefined;
  return (message, options) => String(Reflect.apply(show, undefined, [message, options]));
};

/**
 * The one toaster of a Workspace and its region (internal; `Workspace` renders it once): every `useToast` on the
 * page shows its toasts here, also one called above the Workspace in the screen that renders it.
 */
export const Toasts = () => {
  const t = useOverlayMessages();
  const parts = useToaster();
  const show = showOf(parts, t);
  return <ToastRegion parts={parts} host={(element) => Reflect.set(element, hostKey, show)} />;
};

/**
 * The toast of the page: one sentence at the bottom for five seconds; hovering or focusing it pauses the time, a swipe
 * or Escape closes it, `undo` adds "Undo". A toast reports a deed; it never replaces an error at its place (something
 * that failed to load is `Failed`, something to fix is a `Notice`).
 *
 * It shows in the region of the page's `Workspace`. Without one, the caller owns a toaster of its own, and its
 * region goes to the end of the page with the first toast, in a v2 scope of its own, until the caller goes.
 */
export const useToast = (): ShowToast => {
  const t = useOverlayMessages();
  const parts = useToaster();
  const own = showOf(parts, t);
  let dispose: (() => void) | undefined;
  onCleanup(() => dispose?.());
  return (message, options) => {
    const page = isServer ? undefined : pageToaster();
    if (page) return page(message, options);
    if (!isServer && !dispose) {
      const host = document.createElement("div");
      host.className = "k2-ui";
      host.style.display = "contents";
      document.body.append(host);
      const stop = render(() => <ToastRegion parts={parts} />, host);
      dispose = () => {
        stop();
        host.remove();
      };
    }
    return own(message, options);
  };
};
