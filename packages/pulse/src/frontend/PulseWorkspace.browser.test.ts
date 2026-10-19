import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { launchBrowser } from "../../../ui/test/browser";
import { buildWorkspaceHarness, origin, workspaceFixture } from "./PulseWorkspace.browser-fixture";
import type { PulseWorkspaceProps } from "./workspace/types";

// The post-cut base page: sources with their status, one source in detail, and the in-place hint where
// dashboards and questions used to be. Everything fits a phone and a desktop without horizontal scrolling.
type Browser = Awaited<ReturnType<typeof launchBrowser>>;

let browser: Browser;
let page: (props: PulseWorkspaceProps, locale?: string) => string;

beforeAll(async () => {
  page = await buildWorkspaceHarness();
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

const views = [
  { width: 390, height: 844, touch: true },
  { width: 1440, height: 900, touch: false },
];
const open = async (
  view: (typeof views)[number],
  props: PulseWorkspaceProps,
  locale = "de",
  answer: (url: string) => { status: number; json: unknown } = () => ({ status: 500, json: { code: "UNEXPECTED" } }),
) => {
  const tab = await browser.newPage({ viewport: { width: view.width, height: view.height }, isMobile: view.touch, hasTouch: view.touch });
  // Timers are frozen at the fixture's time: the first frame comes from the server snapshot, and a refresh runs
  // only when a test advances the clock.
  await tab.clock.install({ time: new Date("2026-10-19T12:40:00.000Z") });
  await tab.clock.pauseAt(new Date("2026-10-19T12:40:00.000Z"));
  const calls: string[] = [];
  await tab.route(`${origin}/api/**`, (route) => {
    calls.push(new URL(route.request().url()).pathname);
    return route.fulfill(answer(route.request().url()));
  });
  await tab.route(`${origin}/app/pulse/**`, (route) => route.fulfill({ contentType: "text/html", body: page(props, locale) }));
  await tab.goto(`${origin}/app/pulse/Lad001${props.initialRouteState.view === "coming-back" ? "/dashboards" : "/sources"}`);
  return { tab, calls };
};
const overflow = (tab: Awaited<ReturnType<typeof open>>["tab"]) =>
  tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

describe("Pulse base page after the cut", () => {
  test("sources show their status and newest data on phones and desktops", async () => {
    for (const view of views) {
      const { tab, calls } = await open(view, workspaceFixture);
      try {
        await tab.getByText("Newsletter-Skript").first().waitFor();
        for (const name of ["Shop-Server", "Shop-Bestellungen", "Traefik", "Newsletter-Skript"])
          expect(await tab.getByText(name, { exact: true }).first().isVisible()).toBe(true);
        // Phones show the status inside the source cell; it must be fully inside the viewport, never scrolled away.
        const throttled = await tab.getByText("Gedrosselt").filter({ visible: true }).first().boundingBox();
        expect(throttled).not.toBeNull();
        expect((throttled?.x ?? 0) + (throttled?.width ?? 0)).toBeLessThanOrEqual(view.width);
        expect(await overflow(tab)).toBeLessThanOrEqual(0);
        expect(calls).toEqual([]);
      } finally {
        await tab.close();
      }
    }
  }, 60_000);

  test("a source in detail names refused histograms, skipped summaries and its metric filter", async () => {
    for (const [sourceId, texts] of [
      ["Src003", ["traefik_service_request_duration_seconds", "ohne +Inf-Bucket", "1 Summary, Pulse speichert keine Summaries"]],
      ["Src001", ["node_cpu_seconds_total, node_filesystem_*"]],
      ["Src004", ["Diese Base hat mehr Werte oder Bytes pro Minute gesendet"]],
    ] as const) {
      const { tab } = await open(views[1]!, { ...workspaceFixture, initialRouteState: { view: "sources", sourceId } });
      try {
        for (const text of texts) await tab.getByText(text, { exact: false }).first().waitFor();
        expect(await overflow(tab)).toBeLessThanOrEqual(0);
      } finally {
        await tab.close();
      }
    }
  }, 60_000);

  test("where dashboards used to be, one hint explains what comes back and leads to the sources", async () => {
    for (const view of views) {
      const { tab } = await open(view, { ...workspaceFixture, initialRouteState: { view: "coming-back", sourceId: "" } });
      try {
        await tab.getByText("Dashboards und Fragen kommen zurück").first().waitFor();
        const hint = await tab.getByText("Dashboards und Fragen kommen zurück").first().boundingBox();
        expect(await tab.getByRole("button", { name: "Zu den Quellen" }).isVisible()).toBe(true);
        expect(await overflow(tab)).toBeLessThanOrEqual(0);
        // Nothing loads after the first frame, so the hint stays where it was a few frames later.
        await tab.clock.runFor(100);
        expect(await tab.getByText("Dashboards und Fragen kommen zurück").first().boundingBox()).toEqual(hint);
      } finally {
        await tab.close();
      }
    }
  }, 60_000);

  test("an open sources view refreshes the status every 5 seconds and keeps every row in place", async () => {
    const recovered = workspaceFixture.initialSources.map((source) =>
      source.id === "Src004" ? { ...source, status: { ...source.status, throttled: false, throttledAt: null } } : source,
    );
    const { tab, calls } = await open(views[1]!, workspaceFixture, "de", (url) =>
      new URL(url).pathname === "/api/pulse/bases/Lad001/sources" ? { status: 200, json: recovered } : { status: 500, json: {} },
    );
    try {
      const throttled = () =>
        tab.evaluate(
          () =>
            [...document.querySelectorAll(".k2b-status-badge__label")].filter(
              (label) => label.textContent === "Gedrosselt" && label.checkVisibility(),
            ).length,
        );
      expect(await throttled()).toBe(1);
      const rows = () => tab.evaluate(() => [...document.querySelectorAll("tbody tr")].map((row) => row.getBoundingClientRect().top));
      const before = await rows();
      await tab.clock.runFor(4_900);
      expect(calls).toEqual([]);
      await tab.clock.runFor(200);
      // The response arrives over the real network; poll from the test side, whose timers are not frozen.
      for (let attempt = 0; attempt < 50 && (await throttled()) > 0; attempt++) await Bun.sleep(100);
      expect(await throttled()).toBe(0);
      expect(calls).toEqual(["/api/pulse/bases/Lad001/sources"]);
      expect(await rows()).toEqual(before);
    } finally {
      await tab.close();
    }
  }, 60_000);
});
