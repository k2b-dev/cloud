import { onCleanup, onMount, Show } from "solid-js";
import { isServer, render } from "solid-js/web";
import { type ToasterParts, type ToastKind, useToaster } from "./behavior/toast";
import { Icon } from "./marks";
import { useOverlayMessages } from "./overlay-messages";

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

/** The toasts of one owner at the bottom in the middle, newest on top, at most three; nothing moves when one comes. */
const ToastRegion = (props: { parts: ToasterParts }) => {
  const { Region, Toast, Title, Action } = props.parts;
  return (
    <Region
      class="k2-toasts"
      data-k2-part="Toast"
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

/**
 * The toast of the place you are in: one sentence at the bottom of the page for five seconds; hovering or focusing it
 * pauses the time, a swipe or Escape closes it, `undo` adds "Undo". A toast reports a deed; it never replaces an error
 * at its place (something that failed to load is `Failed`, something to fix is a `Notice`).
 *
 * The toaster belongs to its owner (the component that calls this), never to a module, so a server never shares one
 * between requests. Its region goes to the end of the page once the page is live, in a v2 scope of its own.
 * (k2b-ui gap: `Workspace` could own one toaster for all its screens; until then each owner has its own region.)
 */
export const useToast = (): ShowToast => {
  const t = useOverlayMessages();
  const parts = useToaster();
  onMount(() => {
    if (isServer) return;
    const host = document.createElement("div");
    host.className = "k2-ui";
    host.setAttribute("data-k2-toasts", "");
    document.body.append(host);
    const dispose = render(() => <ToastRegion parts={parts} />, host);
    onCleanup(() => {
      dispose();
      host.remove();
    });
  });
  return (message, options = {}) => {
    const undo = options.undo;
    return parts.toaster.show({
      title: message,
      type: options.status === "bad" ? "error" : options.status === "ok" ? "success" : "default",
      action: undo && { label: t().undo, onAction: undo },
    });
  };
};
