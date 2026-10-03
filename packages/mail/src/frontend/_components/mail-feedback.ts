import { toast } from "@k2b/ui";

/**
 * Reports a failed single action as an error toast whose action repeats it. The toast closes when the retry starts,
 * so a second failure shows a fresh one instead of a stale notice.
 */
export const toastErrorWithRetry = (
  message: string,
  options: { title?: string; retryLabel: string; retry: () => void | Promise<void> },
): void => {
  const notice = toast.error(message, {
    title: options.title,
    action: {
      label: options.retryLabel,
      onClick: () => {
        notice.dismiss();
        void options.retry();
      },
    },
  });
};
