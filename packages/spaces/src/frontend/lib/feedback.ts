import { toast } from "@k2b/ui";

/**
 * Reports a failed single action as an error toast whose Retry repeats it. The toast closes when Retry starts, so a
 * second failure shows a fresh one instead of a stale notice.
 */
export const toastErrorWithRetry = (message: string, retryLabel: string, retry: () => void | Promise<void>) => {
  const notice = toast.error(message, {
    action: {
      label: retryLabel,
      onClick: () => {
        notice.dismiss();
        void retry();
      },
    },
  });
};
