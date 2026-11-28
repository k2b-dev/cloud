import { describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";
import { defaultSelection, parseCloudCalendarRoute, viewWindow } from "./calendar-model";
import { answerFor, NOW, SOURCES, TIME_ZONE, TODAY } from "./cloud-calendar.browser-data";

const root = mkdtempSync(join(tmpdir(), "spaces-cloud-calendar-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: CloudCalendarFixture } = await import("./cloud-calendar.browser-fixture");

const sidebar = {
  spaces: [{ id: "TeamLg", name: "Planning", color: "#6366f1", openItemCount: 9 }],
  pinnedSpaceIds: [],
  recentSpaceIds: [],
  unlistedSpaceCount: 0,
  myWorkCount: 5,
};
const render = (href: string, options: { locale?: "en" | "de"; catalog?: boolean; pending?: string[] } = {}) => {
  setSystemTime(NOW);
  try {
    const locale = options.locale ?? "de";
    const dateConfig = { locale, timeZone: TIME_ZONE, weekStartsOn: 1 as const };
    const route = parseCloudCalendarRoute(new URL(href, "http://spaces.local"), dateConfig);
    const range = viewWindow(route.view, route.date, dateConfig);
    const sources = options.catalog === false ? null : SOURCES;
    const answer = answerFor(range, route.selection ?? defaultSelection(SOURCES));
    const pending = new Set(options.pending ?? []);
    return renderToString(() =>
      createComponent(CloudCalendarFixture, {
        locale,
        sidebar,
        route,
        sources,
        range,
        items: answer.items.filter((item) => !pending.has(item.appId)),
        reads: answer.sources.map((read) => (pending.has(read.appId) ? { ...read, state: "pending" as const } : read)),
        today: TODAY,
        now: NOW.toISOString(),
        canCreateSpace: true,
        dateConfig,
      }),
    );
  } finally {
    setSystemTime();
  }
};

describe("calendar of all Spaces on the server", () => {
  test("the first picture names the view, the calendars, and Calendar in the sidebar", () => {
    const html = render("/app/spaces/calendar?view=week&date=2026-10-27");
    expect(html).toContain("Kalender 9");
    expect(html).toContain("Forklift inspection");
    expect(html).toMatch(/aria-current="page"[^>]*>[\s\S]*?Kalender/);
    expect(html).not.toContain("Early shift");
  });

  test("the first row names what comes next today, not a count of the days in view", () => {
    const html = render("/app/spaces/calendar?view=week&date=2026-10-27");
    const lead = html.match(/class="k2-status-lead"[^>]*>([^<]*)</)?.[1];
    // 10:40 in Berlin: the forklift service runs already; the next entry starts later today.
    // Only when: the entry's title stands in the calendar itself and is not said twice.
    expect(lead).toMatch(/^Nächster um \d\d:\d\d$/);
    expect(html).not.toMatch(/\d+ heute/);
    expect(html).not.toContain("angezeigt");
  });

  test("sources the server had no time for say they load, in the line the browser keeps", () => {
    const html = render("/app/spaces/calendar?view=week&date=2026-10-27", { pending: ["absence"] });
    expect(html).toContain("Lädt 2 von 9 Kalendern …");
  });

  test("no catalog is an error with a way to try again, never an empty calendar", () => {
    const html = render("/app/spaces/calendar?view=week&date=2026-10-27", { catalog: false, locale: "en" });
    expect(html).toContain("Calendars could not be loaded");
    expect(html).toContain("Retry");
    expect(html).not.toContain("No events");
  });

  test("an empty choice says so and offers the default", () => {
    const html = render("/app/spaces/calendar?view=week&date=2026-10-27&cal=");
    // Title and sentence read as two sentences, never run into each other.
    expect(html).toContain("Kein Kalender gewählt. Wähle");
    expect(html).toContain("Standard-Kalender laden");
  });
});
