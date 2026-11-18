import { type DateContext, dates } from "@k2b/stdlib";
import { toast } from "@k2b/ui";
import { mailComposeWindowMessages } from "./mail-compose-window-messages";

export type MailDelivery = { submissionId: string | null; scheduledAt: string | null; undoSeconds: number };

/**
 * The one confirmation after a composer sent or scheduled its message and closed: a short title for the outcome, what
 * happens next as the description, and Undo or Change while the send can still be taken back. `reopen` cancels the
 * submission and brings the draft back where it was written; without it the toast offers no action.
 */
export const showDeliveryToast = (
  delivery: MailDelivery,
  options: { locale: string; dateConfig: DateContext; reopen?: (submissionId: string) => void },
): void => {
  const t = mailComposeWindowMessages.resolve([options.locale]).t;
  const submissionId = delivery.submissionId;
  const reopen = options.reopen;
  const takeBack = (label: string) =>
    submissionId && reopen
      ? {
          label,
          variant: "ghost" as const,
          onClick: () => {
            notice.dismiss();
            reopen(submissionId);
          },
        }
      : null;
  let notice: ReturnType<typeof toast>;
  if (delivery.scheduledAt) {
    notice = toast.success(t.scheduledFor({ value: dates.formatDateTime(delivery.scheduledAt, options.dateConfig) }), {
      title: t.scheduledTitle,
      iconClass: "ti ti-clock",
      action: takeBack(t.change),
    });
    return;
  }
  if (delivery.undoSeconds > 0 && submissionId && reopen) {
    // Nothing has left yet: an info toast, which lasts exactly as long as the send can still be undone.
    notice = toast(t.sendingIn({ seconds: delivery.undoSeconds }), {
      title: t.sendingTitle,
      iconClass: "ti ti-send",
      duration: delivery.undoSeconds * 1000,
      action: takeBack(t.undo),
    });
    return;
  }
  notice = toast.success(delivery.undoSeconds > 0 ? t.sendingIn({ seconds: delivery.undoSeconds }) : t.sent, {
    title: delivery.undoSeconds > 0 ? t.sendingTitle : t.sentTitle,
    iconClass: "ti ti-send",
  });
};
