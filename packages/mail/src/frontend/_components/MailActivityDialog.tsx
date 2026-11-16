import type { DateContext } from "@k2b/stdlib";
import { ActivityList, openActivityDialog, prompts } from "@k2b/ui";
import type { MailActivityEvent } from "../../service/collaboration";
import { mailActivityEntry } from "./mail-activity-presentation";
import { mailReaderMessages } from "./mail-reader-messages";

/** "…" → "Show activity": what happened to the conversation as the shared timeline, newest first. */
export const openMailActivityDialog = (options: {
  activity: readonly MailActivityEvent[];
  unavailable: boolean;
  onRetry: () => void;
  dateConfig: DateContext;
  locale: string;
}): Promise<unknown> => {
  const t = mailReaderMessages.resolve([options.locale]).t;
  if (options.unavailable)
    return prompts.dialog<void>(
      (close) => (
        <ActivityList.Error
          text={t.activityUnavailable}
          onReload={() => {
            close();
            options.onRetry();
          }}
        />
      ),
      { title: t.activityTitle, size: "large" },
    );
  return openActivityDialog({
    entries: () => options.activity.map((event) => mailActivityEntry(event, options.locale)),
    title: t.activityTitle,
    emptyText: t.noActivity,
    dateConfig: options.dateConfig,
  });
};
