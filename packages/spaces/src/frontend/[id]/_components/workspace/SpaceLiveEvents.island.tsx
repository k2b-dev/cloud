import { liveConnection } from "@k2b/cloud/browser/live";
import { reloadOnce } from "@k2b/cloud/browser/reload";
import { type DateContext, dates } from "@k2b/stdlib";
import { type ToastHandle, toast } from "@k2b/ui";
import { onCleanup, onMount } from "solid-js";
import { type SpaceLiveEvent, SpaceLiveEventSchema } from "../../../../live-events";
import { useSpaceMessages } from "../../messages";
import { invalidateSpacesData, type SpacesDataDomain } from "./workspace-events";

type Props = {
  spaceId: string;
  initialCursor: string | null;
  /** The day the SSR snapshot's deadline views were computed for. */
  snapshotDay: string;
  dateConfig?: DateContext;
};

const ALL_DOMAINS: SpacesDataDomain[] = ["view", "detail", "wormholes"];

/** The Space's name, settings, or access shape the whole page. */
const changesPage = (event: SpaceLiveEvent) => event.type.startsWith("space.") || event.type === "access.changed";

export default function SpaceLiveEvents(props: Props) {
  const t = useSpaceMessages();
  onMount(() => {
    let stopped = false;
    let unavailable: ToastHandle | null = null;
    // A condition that persists across loads must not reload the page forever.
    const reload = () => {
      if (stopped || unavailable || reloadOnce(`spaces:live:${props.spaceId}`)) return;
      unavailable = toast(t.liveUpdatesUnavailable, { duration: 0, action: { label: t.reload, onClick: () => window.location.reload() } });
    };

    // Deadline views (overdue, today, this week) depend on the current day, and no event announces a new day.
    // A page without an SSR cursor may have missed changes before its subscription started. A failed
    // refresh keeps the old day, so the next return to the tab tries again.
    const today = () => dates.formatDateKey(new Date(), props.dateConfig);
    let snapshotDay = props.initialCursor === null ? null : props.snapshotDay;
    const refreshForNewDay = () => {
      const day = today();
      if (stopped || document.visibilityState !== "visible" || day === snapshotDay) return;
      invalidateSpacesData(ALL_DOMAINS).then(
        () => (snapshotDay = day),
        () => undefined,
      );
    };

    const subscription = liveConnection("/api/spaces/live").subscribe(
      "space",
      { space: props.spaceId },
      {
        cursor: props.initialCursor,
        parse: (data) => SpaceLiveEventSchema.parse(data),
        apply: async (events) => {
          const changes = events.map((event) => event.data);
          if (changes.some(changesPage)) return reload();
          const domains = new Set<SpacesDataDomain>(["view"]);
          const items = new Set<string>();
          for (const change of changes) {
            if ("itemId" in change) {
              domains.add("detail");
              items.add(change.itemId);
            } else domains.add("wormholes");
          }
          // One named item lets an open detail of another item stay as it is.
          await invalidateSpacesData([...domains], events.at(-1)?.cursor ?? null, items.size === 1 ? ([...items][0] ?? null) : null);
        },
        resync: () => invalidateSpacesData(ALL_DOMAINS),
        revoked: reload,
        unavailable: reload,
      },
    );

    refreshForNewDay();
    document.addEventListener("visibilitychange", refreshForNewDay);
    onCleanup(() => {
      stopped = true;
      document.removeEventListener("visibilitychange", refreshForNewDay);
      subscription.close();
      unavailable?.dismiss();
    });
  });

  return null;
}
