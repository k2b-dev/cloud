import { type DateContext, dates } from "@k2b/stdlib";
import { Format, useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import { chatMessages } from "../messages";
import type { Thread } from "./threads";

/** Display fields supplied by the owning application's authorized reader. */
export default function ThreadMetadata(props: { resource: Thread["resource"]; dateConfig: DateContext }) {
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  const calendarDay = (value: string) => dates.formatDateKey(value, props.dateConfig);
  // Event ends are exclusive. The instant immediately before the boundary is
  // on the last included calendar day, including daylight-saving transitions.
  const lastDay = (value: string) => calendarDay(new Date(new Date(value).getTime() - 1).toISOString());
  return (
    <span class="chat-item-metadata">
      <Show when={props.resource?.deadline}>
        {(deadline) => (
          <span>
            {t().itemDue}:{" "}
            <Show
              when={props.resource?.deadlineAllDay}
              fallback={<Format.DateTime value={deadline()} timeZone={props.dateConfig.timeZone} />}
            >
              <Format.Date value={deadline().slice(0, 10)} timeZone="UTC" />
            </Show>
          </span>
        )}
      </Show>
      <Show when={props.resource?.startsAt}>
        {(start) => (
          <span>
            {t().itemSchedule}:{" "}
            <Show when={props.resource?.allDay} fallback={<Format.DateTime value={start()} timeZone={props.dateConfig.timeZone} />}>
              <Format.Date value={calendarDay(start())} timeZone="UTC" />
            </Show>
            <Show
              when={
                props.resource?.endsAt && (!props.resource.allDay || lastDay(props.resource.endsAt) !== calendarDay(start()))
                  ? props.resource.endsAt
                  : undefined
              }
            >
              {(end) => (
                <>
                  {" "}
                  –{" "}
                  <Show when={props.resource?.allDay} fallback={<Format.DateTime value={end()} timeZone={props.dateConfig.timeZone} />}>
                    <Format.Date value={lastDay(end())} timeZone="UTC" />
                  </Show>
                </>
              )}
            </Show>
          </span>
        )}
      </Show>
      <Show when={props.resource?.assignees?.length}>
        <span>
          {t().itemAssignees}: {props.resource?.assignees?.join(", ")}
        </span>
      </Show>
    </span>
  );
}
