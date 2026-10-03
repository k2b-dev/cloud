import { type ToastHandle, toast } from "@k2b/ui";
import { onCleanup } from "solid-js";

export type RetryToastOptions = { title?: string; retryLabel: string; retry: () => void | Promise<void> };

/**
 * Creates the error toasts with Retry for one component; call it while the component is set up. A toast closes when
 * its Retry starts, so a second failure shows a fresh one, and every toast closes with the component, so a Retry never
 * runs against a view that is gone.
 */
export const createRetryToasts = (): ((message: string, options: RetryToastOptions) => void) => {
  const notices = new Set<ToastHandle>();
  onCleanup(() => {
    for (const notice of notices) notice.dismiss();
    notices.clear();
  });
  return (message, options) => {
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
  };
};
