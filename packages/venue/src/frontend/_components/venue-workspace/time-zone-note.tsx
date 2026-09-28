import { InlineGuidance, useLocale } from "@k2b/ui";
import { createSignal, onMount, Show } from "solid-js";
import { venueMessages } from "../../../messages";
import { timeZoneName } from "../../../time-format";

/**
 * Names the time zone Venue times use, but only for viewers whose device runs
 * in another one. The server cannot know the viewer's zone, so the note
 * appears after hydration. `times` are the instants the view shows, so the
 * name says summer or standard time as it applies to them.
 */
export function VenueTimeZoneNote(props: { timeZone: string; times: readonly string[] }) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const [viewerTimeZone, setViewerTimeZone] = createSignal<string | null>(null);
  onMount(() => setViewerTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone));
  return (
    <Show when={viewerTimeZone() !== null && viewerTimeZone() !== props.timeZone}>
      <InlineGuidance tone="info" icon="ti ti-world">
        {t().venueTimeZoneNote({ zone: timeZoneName(props.timeZone, locale(), props.times), id: props.timeZone })}
      </InlineGuidance>
    </Show>
  );
}
