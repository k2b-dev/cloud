import { type AuthContext, expectUserBackedActor, getDateConfig, getLocale } from "@k2b/cloud/server";
import { logger } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { dates } from "@k2b/stdlib";
import { ssr } from "../../config";
import { spacesPageHelp } from "../../help";
import { loadCalendarEvents, loadCalendarSources } from "../../service/calendar-view";
import { loadSpacesSidebar } from "../../service/overview";
import { spaceMessages } from "../[id]/messages";
import CloudCalendar from "./CloudCalendar.island";
import {
  type CalendarSourceRead,
  type CalendarSourceView,
  defaultSelection,
  itemKey,
  parseCloudCalendarRoute,
  requestBatches,
  requestRanges,
  SEVERITY,
  type SourcedCalendarItem,
  splitCalendarKey,
  viewWindow,
} from "./calendar-model";
import { calendarViewMessages } from "./messages";

const log = logger("spaces:calendar");
/** The server waits this long for all sources together, then shows what is there; the browser loads the rest. */
const SSR_BUDGET_MS = 2_500;

/** The calendar of everything a person can see in Cloud: all their Spaces and the calendars other apps offer. */
export default ssr<AuthContext>(async (c) => {
  const started = Date.now();
  const locale = getLocale(c);
  const { t } = calendarViewMessages.resolve([locale]);
  const user = expectUserBackedActor(c);
  const dateConfig = getDateConfig(c);
  const route = parseCloudCalendarRoute(new URL(c.req.url), dateConfig);
  const range = viewWindow(route.view, route.date, dateConfig);
  const sidebarPromise = loadSpacesSidebar({ userId: user.id, cookieHeader: c.req.header("Cookie"), dateConfig });

  let sources: CalendarSourceView[] | null = null;
  try {
    sources = await loadCalendarSources(c, { deadlineMs: SSR_BUDGET_MS });
  } catch (error) {
    log.warn("Could not list calendar sources", { error: error instanceof Error ? error.message : "Unknown error" });
  }
  const known = new Set(sources?.flatMap((source) => source.calendars.map((calendar) => `${source.appId}:${calendar.id}`)) ?? []);
  const selection = route.selection ?? defaultSelection(sources ?? []);
  const calendars = selection.filter((key) => known.has(key)).flatMap((key) => splitCalendarKey(key) ?? []);
  let items: SourcedCalendarItem[] = [];
  let reads: CalendarSourceRead[] = [];
  if (sources && calendars.length > 0) {
    // Requests the route accepts: six weeks across a clock change and many calendars take more than one.
    const byKey = new Map<string, SourcedCalendarItem>();
    const byApp = new Map<string, CalendarSourceRead>();
    const worse = (read: CalendarSourceRead) => {
      const current = byApp.get(read.appId);
      if (!current || SEVERITY[read.state] > SEVERITY[current.state]) byApp.set(read.appId, read);
    };
    for (const part of requestRanges(range, dateConfig))
      for (const batch of requestBatches(calendars.map((entry) => `${entry.appId}:${entry.calendarId}`))) {
        const chosen = batch.flatMap((key) => splitCalendarKey(key) ?? []);
        try {
          const answer = await loadCalendarEvents(c, {
            ...part,
            calendars: chosen,
            deadlineMs: Math.max(0, SSR_BUDGET_MS - (Date.now() - started)),
          });
          for (const item of answer.items) byKey.set(itemKey(item), item);
          for (const read of answer.sources) worse(read);
        } catch (error) {
          log.warn("Could not read calendar events", { error: error instanceof Error ? error.message : "Unknown error" });
          // The browser asks once more for every source the server could not read.
          for (const entry of chosen) worse({ appId: entry.appId, state: "pending", error: null });
        }
      }
    items = [...byKey.values()];
    reads = [...byApp.values()];
  }
  const sidebar = await sidebarPromise;

  return () => (
    <Layout
      c={c}
      help={spacesPageHelp.calendar}
      fullWidth
      title={[
        { title: spaceMessages.resolve([locale]).t.start, href: "/" },
        { title: "Spaces", href: "/app/spaces" },
        { title: t.calendar },
      ]}
    >
      <CloudCalendar
        sidebar={sidebar}
        route={route}
        sources={sources}
        range={range}
        items={items}
        reads={reads}
        today={dates.formatDateKey(dates.today(dateConfig), dateConfig)}
        canCreateSpace
        dateConfig={dateConfig}
      />
    </Layout>
  );
});
