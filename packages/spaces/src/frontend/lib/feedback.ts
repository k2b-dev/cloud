import { type ToastHandle, toast } from "@k2b/ui";
import { onCleanup } from "solid-js";

/** The toast rail shows at most three toasts and closes older ones as new ones arrive. */
const LIVE_TOASTS = 3;

export type RetryToast = (message: string, retryLabel: string, retry: () => void | Promise<void>, options?: RetryToastOptions) => void;
export type RetryToastOptions = {
  /** Keeps the toast until it is closed; use it when Retry carries input that would otherwise be lost. */
  untilClosed?: boolean;
};

/**
 * Creates the error toasts with Retry for one component; call it while the component is set up. A toast closes when
 * its Retry starts, so a second failure shows a fresh one. Every toast closes with the component, and a failure that
 * arrives after it is gone shows none, so a Retry never runs against a view that no longer exists.
 */
export const createRetryToasts = (): RetryToast => {
  const notices = new Set<ToastHandle>();
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    for (const notice of notices) notice.dismiss();
    notices.clear();
  });
  return (message, retryLabel, retry, options) => {
    if (disposed) return;
    const notice = toast.error(message, {
      ...(options?.untilClosed ? { duration: 0 } : {}),
      action: {
        label: retryLabel,
        onClick: () => {
          notices.delete(notice);
          notice.dismiss();
          void retry();
        },
      },
    });
    notices.add(notice);
    // Only the newest handles can still be open; keeping the rest would grow with every failure.
    for (const older of notices) {
      if (notices.size <= LIVE_TOASTS) break;
      notices.delete(older);
    }
  };
};

const STATUS_ATTRIBUTE = "data-spaces-status";
/** A region that already exists when its text arrives is announced reliably, unlike one inserted with its text. */
const ANNOUNCE_DELAY_MS = 100;
const ANNOUNCEMENT_LIFETIME_MS = 5_000;

/**
 * Tells screen readers about a change the screen shows but the focused control does not say, without a visible
 * message: an assignment made with a shortcut, a completion whose button was busy, a posted comment. One persistent,
 * polite region serves every view, and each message is its own line, so the same message twice is read twice.
 */
export const announceStatus = (message: string): void => {
  if (typeof document === "undefined" || !message) return;
  let region = document.querySelector<HTMLElement>(`[${STATUS_ATTRIBUTE}]`);
  if (!region) {
    region = document.createElement("div");
    region.setAttribute(STATUS_ATTRIBUTE, "");
    region.setAttribute("role", "status");
    // A status region is atomic by default, which would read every line still in it again with each new one.
    region.setAttribute("aria-atomic", "false");
    region.className = "sr-only";
    document.body.append(region);
  }
  const target = region;
  const line = document.createElement("div");
  line.textContent = message;
  setTimeout(() => {
    target.append(line);
    setTimeout(() => line.remove(), ANNOUNCEMENT_LIFETIME_MS);
  }, ANNOUNCE_DELAY_MS);
};
