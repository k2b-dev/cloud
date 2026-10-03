import { type ToastHandle, toast } from "@k2b/ui";
import { onCleanup } from "solid-js";

export type RetryToastOptions = { title?: string; retryLabel: string; retry: () => void | Promise<void> };

/** The toast rail shows at most three toasts and closes older ones as new ones arrive. */
const LIVE_TOASTS = 3;

/**
 * Creates the error toasts with Retry for one component; call it while the component is set up. A toast closes when
 * its Retry starts, so a second failure shows a fresh one. Every toast closes with the component, and a failure that
 * arrives after it is gone shows none, so a Retry never runs against a view that no longer exists.
 */
export const createRetryToasts = (): ((message: string, options: RetryToastOptions) => void) => {
  const notices = new Set<ToastHandle>();
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    for (const notice of notices) notice.dismiss();
    notices.clear();
  });
  return (message, options) => {
    if (disposed) return;
    const notice = toast.error(message, {
      title: options.title,
      action: {
        label: options.retryLabel,
        onClick: () => {
          notices.delete(notice);
          notice.dismiss();
          void options.retry();
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
