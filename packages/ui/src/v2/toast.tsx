import { Show } from "solid-js";
import { render } from "solid-js/web";
import { toastQueue, useToastRegion } from "./behavior/toast-region";
import { Icon } from "./marks";
import { pageOverlayMessages, useOverlayMessages } from "./overlay-messages";

export type ToastOptions = {
  /** Takes the deed back: the toast offers "Undo" and runs this when pressed. */
  undo?: () => unknown;
  /** `ok` for a deed that worked, `bad` for one that failed (announced at once). Without it the toast only reports. */
  status?: "ok" | "bad";
};

const statusIcon = { ok: "circle-check", bad: "alert-triangle" } as const;

/** The page's toasts at the bottom in the middle, newest on top, at most three; nothing moves when one comes. */
const ToastRegion = () => {
  const t = useOverlayMessages();
  const region = useToastRegion(() => t().notifications);
  return (
    <region.Region
      class="k2-toasts"
      data-k2-part="Toast"
      render={(toast) => (
        <region.Toast id={toast.id} class="k2-toast" data-status={toast.entry.status}>
          <Show when={toast.entry.status}>{(status) => <Icon name={statusIcon[status()]} tone={status()} />}</Show>
          <region.Title id={toast.id} class="k2-toast-text">
            {toast.entry.message}
          </region.Title>
          <Show when={toast.entry.action}>
            {(action) => (
              <region.Action toast={toast.id} class="k2-btn" data-variant="text">
                <span class="k2-btn-label">{action().label}</span>
              </region.Action>
            )}
          </Show>
        </region.Toast>
      )}
    />
  );
};

const hostAttribute = "data-k2-toasts";

/**
 * Shows the region once per page, on the first toast. It lives in its own v2 scope at the end of the page, so a toast
 * needs no setup and every island's toasts land in the same place (the queue is the page's, not a module's).
 */
const ensureRegion = () => {
  if (typeof document === "undefined" || document.querySelector(`[${hostAttribute}]`)) return;
  const host = document.createElement("div");
  host.className = "k2-ui";
  host.setAttribute(hostAttribute, "");
  document.body.append(host);
  render(() => <ToastRegion />, host);
};

/**
 * Reports a deed in one sentence at the bottom of the page, for five seconds; hovering or focusing it pauses the time,
 * a swipe or Escape closes it. `undo` adds "Undo". A toast never replaces an error at its place: something that
 * failed to load is `Failed`, something to fix is a `Notice`. Returns the toast's id.
 */
export const toast = (message: string, options: ToastOptions = {}): string => {
  ensureRegion();
  const undo = options.undo;
  return toastQueue().show({
    message,
    status: options.status,
    action: undo && { label: pageOverlayMessages().undo, onAction: undo },
  });
};
