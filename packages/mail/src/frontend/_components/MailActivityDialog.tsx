import { type DateContext, dates } from "@k2b/stdlib";
import { Placeholder, prompts } from "@k2b/ui";
import { For, Show } from "solid-js";
import type { MailActivityEvent } from "../../service/collaboration";
import { presentMailActivity } from "./mail-activity-presentation";
import { mailReaderMessages } from "./mail-reader-messages";

/** "…" → "Show activity": what happened to the conversation, newest first, as the former details panel listed it. */
export const openMailActivityDialog = (options: {
  activity: readonly MailActivityEvent[];
  unavailable: boolean;
  onRetry: () => void;
  dateConfig: DateContext;
  locale: string;
}): Promise<unknown> => {
  const t = mailReaderMessages.resolve([options.locale]).t;
  const items = presentMailActivity([...options.activity], options.locale);
  return prompts.dialog<void>(
    (close) => (
      <Show
        when={!options.unavailable}
        fallback={
          <Placeholder
            state="error"
            variant="compact"
            align="left"
            title={t.activityUnavailable}
            onRetry={() => {
              close();
              options.onRetry();
            }}
          />
        }
      >
        <Show when={items.length > 0} fallback={<p class="text-sm text-secondary">{t.noActivity}</p>}>
          <ol class="mail-activity-rows" data-mail-activity-list>
            <For each={items}>
              {(event) => (
                <li class="mail-activity-row">
                  <i
                    class={`ti ${event.outcome === "failed" ? "ti-alert-circle text-red-500" : `${event.icon} text-dimmed`}`}
                    aria-hidden="true"
                  />
                  <span class="min-w-0 flex-1 text-secondary">
                    <span class="font-medium text-primary">{event.actorLabel}</span> {event.label}
                    <Show when={event.count > 1}> ({event.count})</Show>
                  </span>
                  <time
                    class="shrink-0 text-xs text-dimmed"
                    dateTime={event.createdAt}
                    title={dates.formatDateTime(event.createdAt, options.dateConfig)}
                  >
                    {dates.formatDateTimeRelative(event.createdAt, options.dateConfig)}
                  </time>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </Show>
    ),
    { title: t.activityTitle, icon: "ti ti-activity", size: "medium" },
  );
};
