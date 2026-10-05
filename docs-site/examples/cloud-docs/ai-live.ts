import { aiLive } from "@k2b/cloud/ai/live";
import { type AiInvalidation, AiInvalidationSchema } from "@k2b/cloud/ai/live-events";
import { liveConnection } from "@k2b/cloud/browser/live";

/** Server, before loading the page's state: the cursor that the browser subscribes from. */
export const loadAiLiveCursor = (): Promise<string> => aiLive.cursor();

/** Browser: reload the views an update names before the cursor moves; reload every view when replay is impossible. */
export const followAiLiveUpdates = (view: {
  cursor: string;
  reloadViewsFor: (changes: AiInvalidation[]) => Promise<void>;
  reloadEveryView: () => Promise<void>;
  showUpdatesPaused: () => void;
}) =>
  liveConnection("/api/ai/live").subscribe(
    "user",
    {},
    {
      cursor: view.cursor,
      parse: (data) => AiInvalidationSchema.parse(data),
      apply: async (events) => view.reloadViewsFor(events.map((event) => event.data)),
      resync: view.reloadEveryView,
      unavailable: view.showUpdatesPaused,
    },
  );
