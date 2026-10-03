import { type ToastHandle, toast } from "@k2b/ui";
import { onCleanup } from "solid-js";

/**
 * Creates the error toasts with Retry for one component; call it while the component is set up. A toast closes when
 * its Retry starts, so a second failure shows a fresh one. Every toast closes with the component, and a failure that
 * arrives after it is gone shows none, so a Retry never runs against a view that no longer exists.
 */
export const createRetryToasts = (): ((message: string, retryLabel: string, retry: () => void | Promise<void>) => void) => {
  const notices = new Set<ToastHandle>();
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    for (const notice of notices) notice.dismiss();
    notices.clear();
  });
  return (message, retryLabel, retry) => {
    if (disposed) return;
    const notice = toast.error(message, {
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
  };
};
