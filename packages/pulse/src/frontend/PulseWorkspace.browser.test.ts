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
const open = async (view: (typeof views)[number], props: PulseWorkspaceProps, locale = "de") => {
  const tab = await browser.newPage({ viewport: { width: view.width, height: view.height }, isMobile: view.touch, hasTouch: view.touch });
  // Nothing on this page may call an API: the server snapshot covers every read.
  const calls: string[] = [];
  await tab.route(`${origin}/api/**`, (route) => {
    calls.push(route.request().url());
    return route.fulfill({ status: 500, json: { code: "UNEXPECTED" } });
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
        expect(await tab.getByText("Gedrosselt").first().isVisible()).toBe(true);
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
        // Nothing loads after the first frame, so the hint never moves.
        await tab.waitForTimeout(300);
        expect(await tab.getByText("Dashboards und Fragen kommen zurück").first().boundingBox()).toEqual(hint);
      } finally {
        await tab.close();
      }
    }
  }, 60_000);
});
