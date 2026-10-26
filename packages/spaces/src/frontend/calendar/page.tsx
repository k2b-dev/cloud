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
  parseCloudCalendarRoute,
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
    try {
      const answer = await loadCalendarEvents(c, {
        from: range.from,
        to: range.to,
        calendars,
        deadlineMs: Math.max(0, SSR_BUDGET_MS - (Date.now() - started)),
      });
      items = answer.items;
      reads = answer.sources;
    } catch (error) {
      log.warn("Could not read calendar events", { error: error instanceof Error ? error.message : "Unknown error" });
      // The browser asks once more for every source the server could not read.
      reads = [...new Set(calendars.map((entry) => entry.appId))].map((appId) => ({ appId, state: "pending", error: null }));
    }
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
