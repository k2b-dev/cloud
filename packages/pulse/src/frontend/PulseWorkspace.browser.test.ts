import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { launchBrowser } from "../../../ui/test/browser";
import {
  baseOverviewFixture,
  buildWorkspaceHarness,
  origin,
  overviewWorkspaceFixture,
  renderWorkspaceSnapshot,
  workspaceFixture,
} from "./PulseWorkspace.browser-fixture";
import { buildPulseWorkspaceHref, readWorkspacePathState } from "./workspace/routes";
import { sqlTestLimits, sqlTestQuery } from "./workspace/sql-test-fixtures";
import type { PulseWorkspaceProps } from "./workspace/types";

// The post-cut base page: sources with their status, one source in detail, and the in-place hint where
// dashboards and questions used to be. Everything fits a phone and a desktop without horizontal scrolling.
type Browser = Awaited<ReturnType<typeof launchBrowser>>;

let browser: Browser;
let page: Awaited<ReturnType<typeof buildWorkspaceHarness>>;

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
  answer: (url: string) => { status: number; json: unknown } | Promise<{ status: number; json: unknown }> = () => ({
    status: 500,
    json: { code: "UNEXPECTED" },
  }),
) => {
  const tab = await browser.newPage({ viewport: { width: view.width, height: view.height }, isMobile: view.touch, hasTouch: view.touch });
  // Timers are frozen at the fixture's time: the first frame comes from the server snapshot, and a refresh runs
  // only when a test advances the clock.
  await tab.clock.install({ time: new Date("2026-10-19T12:40:00.000Z") });
  await tab.clock.pauseAt(new Date("2026-10-19T12:40:00.000Z"));
  const calls: string[] = [];
  await tab.route(`${origin}/api/**`, async (route) => {
    calls.push(new URL(route.request().url()).pathname);
    return route.fulfill(await answer(route.request().url()));
  });
  await tab.route(`${origin}/app/pulse/**`, (route) => route.fulfill({ contentType: "text/html", body: page(props, locale) }));
  await tab.goto(`${origin}${buildPulseWorkspaceHref({ baseId: props.initialBaseId, state: props.initialRouteState })}`);
  return { tab, calls };
};
const overflow = (tab: Awaited<ReturnType<typeof open>>["tab"]) =>
  tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

describe("Pulse base overview", () => {
  test("the real SSR page fills the available app height and keeps long content in its own scroller", async () => {
    let desktopNumberHeight: number | undefined;
    for (const view of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
      { width: 1440, height: 600 },
    ]) {
      const props: PulseWorkspaceProps =
        view.width === 390 || view.height === 600
          ? {
              ...overviewWorkspaceFixture,
              initialOverview: {
                error: null,
                data: {
                  ...baseOverviewFixture,
                  attention: {
                    total: 12,
                    nextOffset: null,
                    items: Array.from({ length: 12 }, (_, index) => ({
                      ...baseOverviewFixture.attention.items[0]!,
                      id: `Alert${index}`,
                      name: `Response ${index + 1}`,
                    })),
                  },
                },
              },
            }
          : overviewWorkspaceFixture;
      const serverHtml = await renderWorkspaceSnapshot(props, "de", true);
      const tab = await browser.newPage({ viewport: view });
      tab.setDefaultTimeout(5_000);
      const errors: string[] = [];
      tab.on("pageerror", (error) => errors.push(error.message));
      await tab.route(`${origin}/api/**`, (route) => route.fulfill({ status: 503, json: { code: "UNEXPECTED" } }));
      await tab.route(`${origin}/app/pulse/**`, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: page(props, "de", false, undefined, { serverHtml, deferMount: true, pageDocument: true }),
        }),
      );
      const geometry = () =>
        tab.evaluate(() => {
          const rect = (selector: string, content = false) => {
            const element = document.querySelector(selector);
            if (!element) throw new Error(`Missing ${selector}`);
            const box = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            const topInset = content ? Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.paddingTop) : 0;
            const bottomInset = content ? Number.parseFloat(style.borderBottomWidth) + Number.parseFloat(style.paddingBottom) : 0;
            return { top: box.top + topInset, bottom: box.bottom - bottomInset, height: box.height - topInset - bottomInset };
          };
          return {
            host: rect(".layout-content-main", true),
            workspace: rect(".k2b-app-workspace"),
            numbers: rect(".pulse-overview__numbers"),
            documentHeight: document.documentElement.scrollHeight,
            documentWidth: document.documentElement.scrollWidth,
          };
        });
      try {
        await tab.clock.install({ time: new Date(props.initialNow!) });
        await tab.clock.pauseAt(new Date(props.initialNow!));
        await tab.goto(`${origin}/app/pulse/Lad001`);
        await tab.evaluate(() => document.fonts.ready);
        await tab.locator(".pulse-overview__headline").waitFor();
        const before = await geometry();
        expect(before.workspace.top).toBeCloseTo(before.host.top, 0);
        expect(before.workspace.bottom).toBeCloseTo(before.host.bottom, 0);
        expect(before.host.bottom).toBeLessThanOrEqual(view.height);
        expect(before.documentHeight).toBeLessThanOrEqual(view.height + 1);
        expect(before.documentWidth).toBeLessThanOrEqual(view.width);
        if (view.width === 1440) {
          if (desktopNumberHeight !== undefined) expect(before.numbers.height).toBeCloseTo(desktopNumberHeight, 0);
          desktopNumberHeight = before.numbers.height;
        }
        expect(await tab.locator(".cloud-app-canvas").getAttribute("data-layout-full-page")).toBe("true");
        expect(await tab.locator("#root").getAttribute("data-mounted")).toBeNull();
        await tab.evaluate(() => {
          const mount = Reflect.get(window, "__pulseMount");
          if (typeof mount !== "function") throw new Error("Missing deferred mount");
          mount();
        });
        await tab.locator('#root[data-mounted="true"]').waitFor();
        expect(await geometry()).toEqual(before);
        if (view.width === 390 || view.height === 600) {
          const scroller = tab.locator(".k2b-app-workspace__main");
          expect(await scroller.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
          await scroller.evaluate((node) => node.scrollTo(0, node.scrollHeight));
          expect(await scroller.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
          const activity = await tab.locator(".pulse-overview__activity").boundingBox();
          const visibleMain = await scroller.boundingBox();
          expect(activity!.y + activity!.height).toBeLessThanOrEqual(visibleMain!.y + visibleMain!.height);
          expect(await tab.evaluate(() => window.scrollY)).toBe(0);
        }
        expect(errors).toEqual([]);
      } finally {
        await tab.close();
      }
    }
  }, 60_000);

  test("initial loading ends only when the overview response is available", async () => {
    const response = Promise.withResolvers<{ status: number; json: unknown }>();
    const { tab } = await open(views[0]!, { ...overviewWorkspaceFixture, initialOverview: undefined }, "de", () => response.promise);
    tab.setDefaultTimeout(5_000);
    try {
      await tab.locator(".pulse-overview__loading").waitFor();
      expect(await tab.locator(".pulse-overview__value").count()).toBe(0);
      response.resolve({ status: 200, json: baseOverviewFixture });
      await tab.getByRole("heading", { name: "1 Sache braucht Aufmerksamkeit" }).waitFor();
      expect(await tab.locator(".pulse-overview__loading").count()).toBe(0);
      expect(await tab.locator(".pulse-overview__value").count()).toBe(4);
    } finally {
      response.resolve({ status: 503, json: { code: "CANCELLED" } });
      await tab.close();
    }
  }, 30_000);

  test("source expectation edits send the current revision and preserve the draft on conflict", async () => {
    const props: PulseWorkspaceProps = { ...workspaceFixture, initialRouteState: { view: "sources", sourceId: "Src002" } };
    const { tab } = await open(views[1]!, props, "de", (url) => ({
      status: 200,
      json: new URL(url).pathname.endsWith("/bases") ? props.initialBases : props.initialSources,
    }));
    tab.setDefaultTimeout(5_000);
    const writes: unknown[] = [];
    await tab.route(`${origin}/api/pulse/bases/Lad001/sources/Src002`, (route) => {
      writes.push(route.request().postDataJSON());
      return route.fulfill({ status: 409, json: { code: "CONFLICT", message: "Fixture revision changed" } });
    });
    try {
      await tab.getByRole("button", { name: /Bearbeiten/ }).click();
      const dialog = tab.locator("dialog[open]");
      await dialog.getByRole("combobox", { name: "Erwartete Daten", exact: true }).click();
      await tab.getByRole("option", { name: "Täglich bis zu einer Uhrzeit", exact: true }).click();
      await dialog.getByRole("textbox", { name: "Erwartet bis", exact: true }).fill("05:30");
      await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
      await dialog.getByRole("alert").waitFor();
      expect(await dialog.getByRole("alert").textContent()).toContain("Die Quelle wurde geändert");
      expect(await dialog.getByRole("textbox", { name: "Erwartet bis", exact: true }).inputValue()).toBe("05:30");
      expect(await dialog.getByRole("button", { name: "Speichern", exact: true }).isDisabled()).toBe(true);
      expect(writes).toEqual([{ name: "Shop-Bestellungen", expectedRevision: 1, expectEverySeconds: null, expectDailyBy: "05:30" }]);
    } finally {
      await tab.close();
    }
  }, 30_000);

  test("SSR and the first browser render preserve the visible overview snapshot", async () => {
    for (const locale of ["de", "en"]) {
      const props = { ...overviewWorkspaceFixture, initialDateConfig: { ...overviewWorkspaceFixture.initialDateConfig, locale } };
      const serverHtml = await renderWorkspaceSnapshot(props, locale);
      const tab = await browser.newPage({ viewport: { width: 390, height: 844 } });
      tab.setDefaultTimeout(5_000);
      const calls: string[] = [],
        errors: string[] = [];
      tab.on("pageerror", (error) => errors.push(error.message));
      await tab.route(`${origin}/api/**`, (route) => {
        calls.push(route.request().url());
        return route.fulfill({ status: 500, json: { code: "UNEXPECTED" } });
      });
      await tab.route(`${origin}/app/pulse/**`, (route) =>
        route.fulfill({ contentType: "text/html", body: page(props, locale, false, undefined, { serverHtml, deferMount: true }) }),
      );
      try {
        await tab.clock.install({ time: new Date(props.initialNow!) });
        await tab.clock.pauseAt(new Date(props.initialNow!));
        await tab.goto(`${origin}/app/pulse/Lad001`);
        await tab.evaluate(() => document.fonts.ready);
        await tab.locator(".pulse-overview__headline").waitFor();
        const snapshot = () =>
          tab.locator(".pulse-overview__headline, .pulse-overview__value, .pulse-overview__activity-time").evaluateAll((nodes) =>
            nodes.map((node) => {
              const box = node.getBoundingClientRect();
              return { text: node.textContent, x: box.x, y: box.y, width: box.width, height: box.height };
            }),
          );
        const before = await snapshot();
        expect(before).toHaveLength(6);
        expect(await tab.locator("#root").getAttribute("data-mounted")).toBeNull();
        await tab.evaluate(() => {
          const mount = Reflect.get(window, "__pulseMount");
          if (typeof mount !== "function") throw new Error("Missing deferred mount");
          mount();
        });
        await tab.locator('#root[data-mounted="true"]').waitFor();
        expect(await snapshot()).toEqual(before);
        expect(calls).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        await tab.close();
      }
    }
  }, 60_000);

  test("View opens the complete alert draft without running it and survives reload and Back", async () => {
    const { tab, calls } = await open(views[1]!, overviewWorkspaceFixture);
    tab.setDefaultTimeout(5_000);
    const sql = `SELECT :host AS host, :label AS label /* ${"context ".repeat(600)} */`;
    const params = { host: "db\\01", label: "A&B ü" };
    await tab.route(`${origin}/app/pulse/**`, (route) => {
      const state = readWorkspacePathState(route.request().url(), "Lad001");
      const props: PulseWorkspaceProps =
        state.alertId === "Alt001"
          ? {
              ...overviewWorkspaceFixture,
              initialRouteState: { ...state, sql, params },
              initialSql: { limits: sqlTestLimits, query: null, error: null },
            }
          : { ...overviewWorkspaceFixture, initialRouteState: state };
      return route.fulfill({ contentType: "text/html", body: page(props) });
    });
    try {
      await tab.getByRole("button", { name: "Ansehen", exact: true }).click();
      await tab.waitForURL(`${origin}/app/pulse/Lad001/sql?alert=Alt001`);
      const assertDraft = async () => {
        const editor = tab.getByRole("textbox", { name: "SQL", exact: true });
        await editor.waitFor();
        expect(await editor.inputValue()).toBe(sql);
        for (const [key, value] of Object.entries(params))
          expect(await tab.getByRole("textbox", { name: `:${key}`, exact: true }).inputValue()).toBe(value);
        expect(new URL(tab.url()).search).toBe("?alert=Alt001");
        expect(calls.filter((path) => path.endsWith("/sql"))).toEqual([]);
      };
      await assertDraft();
      await tab.reload();
      await assertDraft();
      await tab.goBack();
      await tab.waitForURL(`${origin}/app/pulse/Lad001`);
      await tab.getByRole("heading", { name: "1 Sache braucht Aufmerksamkeit" }).waitFor();
      expect(await tab.getByRole("textbox", { name: "SQL", exact: true }).count()).toBe(0);
    } finally {
      await tab.close();
    }
  }, 30_000);

  test("overview and the third source path open the exact unsent Assistant draft", async () => {
    for (const sourcePicker of [false, true]) {
      const { tab } = await open(views[1]!, sourcePicker ? workspaceFixture : overviewWorkspaceFixture);
      tab.setDefaultTimeout(5_000);
      const requests: unknown[] = [];
      await tab.route(`${origin}/api/ai/**`, (route) => {
        const request = route.request();
        requests.push({ path: new URL(request.url()).pathname, method: request.method(), body: request.postDataJSON() });
        return route.fulfill({ status: 201, json: { id: "Cht001", draft: { content: [], revision: 1, updatedAt: null } } });
      });
      await tab.route(`${origin}/app/assistant**`, (route) =>
        route.fulfill({ contentType: "text/html", body: "<p>Assistant fixture</p>" }),
      );
      try {
        if (sourcePicker) {
          await tab.getByRole("button", { name: "Quelle", exact: true }).click();
          const dialog = tab.locator("dialog[open]");
          await dialog.getByRole("heading", { name: "Neue Quelle in Laden" }).waitFor();
          await dialog.getByRole("button", { name: /Mit KI fragen/ }).click();
        } else await tab.getByRole("button", { name: "Mit KI fragen", exact: true }).click();
        await tab.waitForURL(`${origin}/app/assistant?conversation=Cht001`);
        expect(requests).toEqual([
          {
            path: "/api/ai/conversations",
            method: "POST",
            body: {
              launchedByAppId: "pulse",
              title: "Was ist los in Laden?",
              skills: ["cloud-pulse"],
              preloadTools: [
                { appId: "pulse", kind: "query", id: "sql.run" },
                { appId: "pulse", kind: "query", id: "base.read" },
                { appId: "pulse", kind: "query", id: "source.list" },
              ],
              draft: {
                content: [
                  { type: "text", text: "Was braucht in Laden gerade Aufmerksamkeit, und warum?" },
                  {
                    type: "resource",
                    ref: { type: "pulse.base", id: "Lad001" },
                    title: "Laden",
                    icon: "ti ti-activity-heartbeat",
                    href: "/app/pulse/Lad001",
                  },
                ],
              },
            },
          },
        ]);
      } finally {
        await tab.close();
      }
    }
  }, 30_000);
  test("a lost source-create response preserves the draft, blocks resubmission and offers the reconciled source list", async () => {
    const { tab } = await open(views[1]!, workspaceFixture, "de", (url) => ({
      status: 200,
      json: new URL(url).pathname.endsWith("/bases") ? workspaceFixture.initialBases : workspaceFixture.initialSources,
    }));
    let writes = 0,
      reads = 0;
    await tab.route(`${origin}/api/pulse/bases/Lad001/sources`, async (route) => {
      if (route.request().method() === "POST") {
        ++writes;
        return route.abort("failed");
      }
      ++reads;
      return route.fulfill({ status: 200, json: workspaceFixture.initialSources });
    });
    tab.setDefaultTimeout(5_000);
    try {
      await tab.getByRole("button", { name: "Quelle", exact: true }).click();
      const dialog = tab.locator("dialog[open]");
      expect(await dialog.getByRole("button", { name: /Mit KI fragen/ }).isVisible()).toBe(true);
      await dialog.getByRole("button", { name: /Senden/ }).click();
      await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Tägliche Lieferung");
      await dialog.getByRole("button", { name: "Hinzufügen", exact: true }).click();
      await dialog.getByRole("button", { name: "Quellen prüfen", exact: true }).waitFor();
      expect(await dialog.getByRole("textbox", { name: "Name", exact: true }).inputValue()).toBe("Tägliche Lieferung");
      expect(await dialog.getByRole("button", { name: "Hinzufügen", exact: true }).isDisabled()).toBe(true);
      expect(writes).toBe(1);
      expect(reads).toBe(1);
    } finally {
      await tab.close();
    }
  }, 30_000);

  test("retrying a revoked saved-query read cannot redisplay protected rows before authorization succeeds", async () => {
    let reads = 0;
    const pending = Promise.withResolvers<{ status: number; json: unknown }>();
    const { tab } = await open(
      views[1]!,
      {
        ...workspaceFixture,
        initialRouteState: { view: "sql", sourceId: "", sql: "SELECT 1" },
        initialSql: { limits: sqlTestLimits, query: null, error: null },
      },
      "de",
      (url) => {
        if (new URL(url).pathname.endsWith("/queries/Qry001")) return { status: 200, json: sqlTestQuery };
        if (new URL(url).pathname.endsWith("/queries")) {
          ++reads;
          if (reads === 2) return { status: 403, json: { code: "FORBIDDEN" } };
          if (reads === 3) return pending.promise;
          return { status: 200, json: { items: [sqlTestQuery], total: 1, nextOffset: null } };
        }
        return { status: 500, json: {} };
      },
    );
    tab.setDefaultTimeout(5_000);
    try {
      await tab.getByRole("tab", { name: "Gespeichert", exact: true }).click();
      await tab.getByRole("switch", { name: "Auf Übersicht", exact: true }).click();
      const retry = tab.getByRole("button", { name: "Erneut versuchen", exact: true });
      await retry.waitFor();
      expect(await tab.getByRole("button", { name: "CPU", exact: true }).count()).toBe(0);
      await retry.click();
      await tab.getByRole("status").filter({ hasText: "Gespeicherte Abfragen" }).waitFor();
      expect(await tab.getByRole("button", { name: "CPU", exact: true }).count()).toBe(0);
      pending.resolve({ status: 503, json: { code: "UNAVAILABLE" } });
      await retry.waitFor();
      expect(await tab.getByRole("button", { name: "CPU", exact: true }).count()).toBe(0);
      await retry.click();
      await tab.getByRole("button", { name: "CPU", exact: true }).waitFor();
    } finally {
      pending.resolve({ status: 403, json: { code: "FORBIDDEN" } });
      await tab.close();
    }
  }, 30_000);

  test("overview states preserve truthful values and fit phone and desktop", async () => {
    const quiet = { ...baseOverviewFixture, attention: { items: [], total: 0, nextOffset: null } };
    const empty = { ...quiet, sources: { total: 0, current: 0 }, numbers: [], activity: { items: [], nextCursor: null } };
    const states = [
      { data: baseOverviewFixture, error: null, title: "1 Sache braucht Aufmerksamkeit" },
      { data: quiet, error: null, title: "Alles ruhig" },
      { data: empty, error: null, title: "Laden ist noch leer" },
      { data: { ...baseOverviewFixture, storeUnavailable: true }, error: null, title: "Pulse erreicht den Datenspeicher nicht" },
      { data: null, error: { code: "REQUEST_FAILED", message: "Offline" }, title: "Die Übersicht ließ sich nicht laden" },
    ];
    for (const view of views)
      for (const state of states) {
        const { tab, calls } = await open(view, { ...overviewWorkspaceFixture, initialOverview: state });
        tab.setDefaultTimeout(5_000);
        try {
          await tab.getByText(state.title, { exact: true }).first().waitFor();
          await tab.evaluate(() => document.fonts.ready);
          expect(await overflow(tab)).toBeLessThanOrEqual(0);
          expect(calls).toEqual([]);
          if (state.data?.numbers.length) {
            expect(await tab.locator(".pulse-overview__number").count()).toBe(4);
            expect(await tab.locator(".pulse-overview__value").first().textContent()).toContain("42");
            expect(
              await tab
                .locator(".pulse-overview__spark .stdlib-chart-sparkline")
                .evaluateAll((lines) => lines.map((line) => getComputedStyle(line).stroke)),
            ).toEqual(["rgb(20, 184, 166)", "rgb(249, 115, 22)", "rgb(139, 92, 246)", "rgb(236, 72, 153)"]);
          }
          if (state.data?.storeUnavailable) {
            expect(await tab.locator(".pulse-overview__number-time").first().isVisible()).toBe(true);
            expect(await tab.getByRole("button", { name: "Erneut versuchen", exact: true }).isVisible()).toBe(true);
          }
        } finally {
          await tab.close();
        }
      }
  }, 60_000);

  test("60-second refresh preserves anchors and focused actions, retains failure facts and purges denied data", async () => {
    for (const view of views) {
      let answer = { status: 200, json: { ...baseOverviewFixture, readAt: "2026-10-19T12:41:00.000Z", sources: { total: 4, current: 4 } } };
      const { tab, calls } = await open(view, overviewWorkspaceFixture, "de", () => answer);
      tab.setDefaultTimeout(5_000);
      try {
        const action = tab.getByRole("button", { name: "Ansehen", exact: true }).first();
        await action.waitFor();
        await tab.evaluate(() => document.fonts.ready);
        await action.focus();
        await tab.waitForFunction(() => document.activeElement?.textContent?.trim() === "Ansehen");
        const anchorPositions = () =>
          tab.evaluate(() =>
            [".pulse-overview__band", ".pulse-overview__headline", ".pulse-overview__numbers", ".pulse-overview__activity"].map(
              (selector) => {
                const box = document.querySelector(selector)!.getBoundingClientRect();
                return { x: box.x, y: box.y, width: box.width, height: box.height };
              },
            ),
          );
        const before = await anchorPositions();
        const button = await action.elementHandle();
        await tab.clock.runFor(59_999);
        expect(calls).toEqual([]);
        await tab.clock.runFor(1);
        await tab.locator(".pulse-overview__band").getByText("4 von 4 Quellen aktuell", { exact: true }).waitFor();
        expect(await anchorPositions()).toEqual(before);
        expect(await button?.evaluate((node) => node === document.activeElement && node.isConnected)).toBe(true);
        expect(calls).toEqual(["/api/pulse/bases/Lad001/overview"]);
        answer = { status: 503, json: { ...baseOverviewFixture } };
        await tab.clock.runFor(60_000);
        await tab.getByRole("button", { name: "Erneut versuchen", exact: true }).waitFor();
        expect(await tab.locator(".pulse-overview__number").count()).toBe(4);
        answer = { status: 403, json: { ...baseOverviewFixture } };
        await tab.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
        await tab.clock.runFor(1);
        await tab.getByRole("link", { name: "Zu meinen Bases", exact: true }).waitFor();
        expect(await tab.locator(".pulse-overview__number").count()).toBe(0);
        expect(await tab.getByText("Antwortzeit", { exact: true }).count()).toBe(0);
      } finally {
        await tab.close();
      }
    }
  }, 60_000);

  test("pin reconciliation failure stays visible and a successful retry unlocks the switches without repeating the write", async () => {
    let reads = 0,
      writes = 0;
    let row = { ...sqlTestQuery, baseId: "Lad001" };
    const { tab } = await open(
      views[1]!,
      {
        ...workspaceFixture,
        initialRouteState: { view: "sql", sourceId: "", sql: "SELECT 1" },
        initialSql: { limits: sqlTestLimits, query: null, error: null },
      },
      "de",
      (url) => {
        const path = new URL(url).pathname;
        if (path.endsWith("/queries/Qry001")) {
          ++writes;
          row = { ...row, pinned: !row.pinned, revision: row.revision + 1 };
          return { status: 200, json: row };
        }
        if (path.endsWith("/queries")) {
          ++reads;
          return reads === 2
            ? { status: 503, json: { code: "UNAVAILABLE" } }
            : { status: 200, json: { items: [row], total: 51, nextOffset: 50 } };
        }
        return { status: 500, json: {} };
      },
    );
    tab.setDefaultTimeout(5_000);
    try {
      await tab.getByRole("tab", { name: "Gespeichert", exact: true }).click();
      const pin = tab.getByRole("switch", { name: "Auf Übersicht", exact: true });
      await pin.waitFor();
      await pin.click();
      const retry = tab.getByRole("button", { name: "Erneut versuchen", exact: true });
      await retry.waitFor();
      expect(await pin.isDisabled()).toBe(true);
      expect(writes).toBe(1);
      await retry.click();
      await tab.waitForFunction(() => {
        const input = document.querySelector<HTMLInputElement>('input[role="switch"]');
        return input?.checked && !input.disabled;
      });
      expect(writes).toBe(1);
      await pin.click();
      await tab.waitForFunction(() => {
        const input = document.querySelector<HTMLInputElement>('input[role="switch"]');
        return input && !input.checked && !input.disabled;
      });
      expect(writes).toBe(2);
      expect(reads).toBe(4);
    } finally {
      await tab.close();
    }
  }, 30_000);
});

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
        await tab.getByText("Dashboards kommen zurück").first().waitFor();
        const hint = await tab.getByText("Dashboards kommen zurück").first().boundingBox();
        expect(await tab.getByRole("button", { name: "Zu den Quellen" }).isVisible()).toBe(true);
        expect(await overflow(tab)).toBeLessThanOrEqual(0);
        // Nothing loads after the first frame, so the hint stays where it was a few frames later.
        await tab.clock.runFor(100);
        expect(await tab.getByText("Dashboards kommen zurück").first().boundingBox()).toEqual(hint);
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
      await tab.getByText("Gedrosselt", { exact: true }).filter({ visible: true }).first().waitFor();
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

  test("open settings follow a running clear to its failure and offer Retry in place", async () => {
    const base = workspaceFixture.initialBases[0]!;
    const clearing = { ...base, store: { ...base.store, state: "clearing" as const, operation: "clear" as const } };
    const failed = {
      ...base,
      store: { ...clearing.store, state: "failed" as const, errorCode: "STORE_UNAVAILABLE", errorAt: "2026-10-19T12:40:03.000Z" },
    };
    const { tab, calls } = await open(
      views[1]!,
      { ...workspaceFixture, initialBases: [clearing], initialRouteState: { view: "coming-back", sourceId: "" } },
      "de",
      (url) => {
        const path = new URL(url).pathname;
        if (path === "/api/pulse/bases") return { status: 200, json: [failed] };
        if (path.endsWith("/sql/limits")) return { status: 200, json: sqlTestLimits };
        return { status: 500, json: {} };
      },
    );
    try {
      await tab.getByRole("button", { name: "Einstellungen" }).click();
      const settings = tab.locator("dialog[open]");
      const retry = settings.getByRole("button", { name: "Erneut versuchen" });
      await settings.getByText("Allgemein").first().waitFor();
      await settings.getByRole("tab", { name: "Nutzung und Grenzen", exact: true }).click();
      expect(await retry.count()).toBe(0);
      await tab.clock.runFor(5_100);
      await retry.waitFor();
      expect(calls).toContain("/api/pulse/bases");
    } finally {
      await tab.close();
    }
  }, 60_000);

  test("a deleting base on the overview follows its deletion to a failure, a retry and the end, in place", async () => {
    const base = workspaceFixture.initialBases[0]!;
    const deleting = {
      ...base,
      deletionStartedAt: "2026-10-19T12:30:00.000Z",
      store: { ...base.store, state: "deleting" as const, operation: "delete" as const },
    };
    const failed = { ...deleting, store: { ...deleting.store, state: "failed" as const, errorCode: "STORE_UNAVAILABLE" } };
    let answer: { status: number; json: unknown } = { status: 200, json: failed };
    const tab = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await tab.clock.install({ time: new Date("2026-10-19T12:40:00.000Z") });
    await tab.clock.pauseAt(new Date("2026-10-19T12:40:00.000Z"));
    const calls: string[] = [];
    await tab.route(`${origin}/api/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      calls.push(`${route.request().method()} ${path}`);
      if (path.endsWith("/retry")) return route.fulfill({ status: 200, json: deleting });
      return route.fulfill(answer);
    });
    await tab.route(`${origin}/app/pulse/**`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: page(workspaceFixture, "de", false, { bases: [], deletingBases: [deleting], initialQuery: "" }),
      }),
    );
    try {
      await tab.goto(`${origin}/app/pulse/overview`);
      const card = tab.locator("article", { hasText: base.name });
      const retry = card.getByRole("button", { name: "Erneut versuchen" });
      await card.getByText("Wird gelöscht").waitFor();
      const box = await card.boundingBox();
      expect(await retry.isDisabled()).toBe(true);
      // A new failure shows in place, with Retry enabled.
      await tab.clock.runFor(5_100);
      await card.getByText("Fehlgeschlagen").waitFor();
      expect(await retry.isEnabled()).toBe(true);
      await retry.click();
      await card.getByText("Wird gelöscht").waitFor();
      // A failed status lookup says so in the card and enables Retry, which asks again at once.
      answer = { status: 500, json: { code: "INTERNAL", message: "Lookup failed" } };
      await tab.clock.runFor(5_100);
      await card.getByText("Der Zustand ließ sich nicht laden", { exact: false }).waitFor();
      expect(await retry.isEnabled()).toBe(true);
      answer = { status: 200, json: deleting };
      await retry.click();
      await tab.clock.runFor(100);
      await card.getByText("Pulse löscht diese Base im Hintergrund", { exact: false }).waitFor();
      expect(await retry.isDisabled()).toBe(true);
      // The deletion finishes: the card says so and keeps its place until the next reload. Its text may wrap
      // differently, but it is the last element, so nothing else moves.
      answer = { status: 404, json: { code: "NOT_FOUND", message: "Pulse base not found" } };
      await tab.clock.runFor(5_100);
      await card.getByText("Gelöscht", { exact: true }).waitFor();
      expect(await retry.isDisabled()).toBe(true);
      const after = await card.boundingBox();
      expect(after?.y).toBe(box?.y);
      expect(after?.x).toBe(box?.x);
      expect(after?.width).toBe(box?.width);
      expect(calls.filter((call) => call === `GET /api/pulse/bases/${base.id}`).length).toBe(4);
      expect(await overflow(tab)).toBe(0);
    } finally {
      await tab.close();
    }
  }, 60_000);
});

test("Browser Back asks before discarding base settings and Cancel preserves the draft", async () => {
  const { tab } = await open(views[1]!, workspaceFixture);
  try {
    await tab.getByRole("button", { name: "Einstellungen", exact: true }).click();
    const name = tab.getByRole("textbox", { name: "Name", exact: true });
    await name.fill("Laden Entwurf");
    await tab.evaluate(() => window.history.back());
    await tab.getByText("Ungespeicherte Änderungen verwerfen?", { exact: true }).waitFor();
    await tab.getByRole("button", { name: "Abbrechen", exact: true }).last().click();
    expect(await name.inputValue()).toBe("Laden Entwurf");
    expect(new URL(tab.url()).searchParams.get("settings")).toBe("general");
    await name.press("Escape");
    await tab.getByText("Ungespeicherte Änderungen verwerfen?", { exact: true }).waitFor();
    await tab.getByRole("button", { name: "Abbrechen", exact: true }).last().click();
    expect(await name.inputValue()).toBe("Laden Entwurf");
    await tab.evaluate(() => window.history.back());
    await tab.getByRole("button", { name: "Verwerfen", exact: true }).click();
    await tab.waitForFunction(() => !new URL(window.location.href).searchParams.has("settings"));
    expect(await name.count()).toBe(0);
  } finally {
    await tab.close();
  }
}, 30_000);

test("base settings preserve arbitrary values and show only measured usage on phone and desktop", async () => {
  for (const view of views) {
    const base = { ...workspaceFixture.initialBases[0]!, rawRetentionDays: 45 };
    const { tab } = await open(
      view,
      { ...workspaceFixture, initialBases: [base], initialRouteState: { ...workspaceFixture.initialRouteState, settings: "general" } },
      "de",
      (url) => {
        if (new URL(url).pathname.endsWith("/sql/limits")) return { status: 200, json: sqlTestLimits };
        return { status: 200, json: [] };
      },
    );
    try {
      const dialog = tab.locator("dialog[open]");
      await dialog.getByRole("textbox", { name: "Name", exact: true }).waitFor();
      const dialogBox = (await dialog.boundingBox())!;
      if (view.width >= 768) {
        expect(dialogBox.width).toBe(1024);
        expect(dialogBox.height).toBeLessThanOrEqual(642);
      }
      expect(await dialog.getByRole("tab").count()).toBe(5);
      expect(await dialog.getByText("Lebenszyklus", { exact: true }).count()).toBe(0);
      const colors = dialog.getByRole("group", { name: "Farbe", exact: true });
      expect(await colors.getByRole("button").count()).toBe(5);
      await colors.getByRole("button", { name: "Grün", exact: true }).click();
      expect(await colors.getByRole("button", { name: "Grün", exact: true }).getAttribute("aria-pressed")).toBe("true");
      expect(await colors.locator("i").first().getAttribute("class")).toContain(base.icon);
      await dialog.getByRole("textbox", { name: "Beschreibung", exact: true }).fill("A real description");
      await dialog.getByRole("tab", { name: "Aufbewahrung", exact: true }).click();
      const raw = dialog.getByRole("spinbutton", { name: "Aufbewahrung von Rohdaten", exact: true });
      expect(await raw.inputValue()).toBe("45");
      await raw.waitFor();
      const fieldGeometry = await raw.evaluate((element) => {
        const field = element.closest(".k2b-settings-field")!;
        return {
          display: getComputedStyle(field).display,
          columns: getComputedStyle(field).gridTemplateColumns,
          padding: getComputedStyle(field).paddingLeft,
        };
      });
      expect(fieldGeometry.padding).toBe("0px");
      if (view.width >= 768) {
        expect(fieldGeometry.display).toBe("grid");
        expect(fieldGeometry.columns.startsWith("170px ")).toBe(true);
      }
      for (const name of ["Aufbewahrung von Rohdaten", "Aufbewahrung stündlicher Aggregate", "Aufbewahrung sensibler Ereignisdaten"]) {
        const input = dialog.getByRole("spinbutton", { name, exact: true });
        await input.waitFor();
        const descriptionId = await input.getAttribute("aria-describedby");
        expect(descriptionId).toBeTruthy();
        expect(
          await input.evaluate((element) => {
            const id = element.getAttribute("aria-describedby");
            const description = id ? document.getElementById(id) : null;
            return Boolean(description?.textContent?.trim() && description.getClientRects().length);
          }),
        ).toBe(true);
        const presets = dialog.getByRole("group", { name, exact: true });
        expect(await presets.getAttribute("aria-describedby")).toBe(descriptionId);
        expect(
          await presets
            .getByRole("button")
            .evaluateAll(
              (buttons, id) => buttons.length > 0 && buttons.every((button) => button.getAttribute("aria-describedby") === id),
              descriptionId,
            ),
        ).toBe(true);
      }
      const sensitive = dialog.getByRole("spinbutton", { name: "Aufbewahrung sensibler Ereignisdaten", exact: true });
      for (const value of ["24", "125", "8760"]) {
        await sensitive.fill(value);
        await sensitive.press("Tab");
        expect(await sensitive.inputValue()).toBe(value);
        await tab.waitForFunction(() => document.fonts.status === "loaded");
        const fitting = await sensitive.evaluate((element) => {
          if (!(element instanceof HTMLInputElement)) throw new Error("Expected native retention input");
          const style = getComputedStyle(element);
          const context = document.createElement("canvas").getContext("2d")!;
          context.font = style.font;
          return {
            text: context.measureText(element.value).width,
            available: element.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight),
            scroll: element.scrollLeft,
          };
        });
        expect(fitting.available).toBeGreaterThan(fitting.text);
        expect(fitting.scroll).toBe(0);
      }
      await dialog
        .getByRole("group", { name: "Aufbewahrung von Rohdaten", exact: true })
        .getByRole("button", { name: "7 Tage", exact: true })
        .click();
      expect(await raw.inputValue()).toBe("7");
      await raw.fill("46");
      await raw.press("Tab");
      expect(await raw.inputValue()).toBe("46");
      await dialog.getByRole("button", { name: "Verwerfen", exact: true }).click();
      expect(await raw.inputValue()).toBe("45");
      await dialog.getByRole("tab", { name: "Nutzung und Grenzen", exact: true }).click();
      await dialog.getByRole("progressbar").first().waitFor();
      expect(await dialog.getByRole("progressbar").count()).toBe(2);
      expect(await dialog.getByRole("progressbar").first().getAttribute("aria-valuenow")).toBe("36");
      expect(await dialog.getByText("Obergrenze; die aktuelle Rate wird nicht gemessen.", { exact: true }).isVisible()).toBe(true);
      expect(await overflow(tab)).toBeLessThanOrEqual(0);
    } finally {
      await tab.close();
    }
  }
  const { tab } = await open(
    views[0]!,
    {
      ...workspaceFixture,
      initialPermissions: { write: false, admin: false },
      initialRouteState: { ...workspaceFixture.initialRouteState, settings: "general" },
    },
    "de",
    (url) => ({
      status: 200,
      json: new URL(url).pathname.endsWith("/sql/limits") ? sqlTestLimits : [],
    }),
  );
  try {
    const dialog = tab.locator("dialog[open]");
    await dialog.getByRole("textbox", { name: "Name", exact: true }).waitFor();
    expect(await dialog.getByRole("textbox", { name: "Name", exact: true }).isDisabled()).toBe(true);
    expect(
      await dialog.getByRole("group", { name: "Farbe", exact: true }).getByRole("button", { name: "Grün", exact: true }).isDisabled(),
    ).toBe(true);
    expect(await dialog.getByText("Nur Admins der Base können diese Einstellungen ändern.", { exact: false }).isVisible()).toBe(true);
  } finally {
    await tab.close();
  }
}, 60_000);

test("SQL usage loading and failure preserve known base facts and recover without a false measurement", async () => {
  for (const view of views) {
    let release: (() => void) | undefined;
    let fail = true;
    const { tab } = await open(
      view,
      { ...workspaceFixture, initialRouteState: { view: "sources", sourceId: "", settings: "usage" } },
      "de",
      async (url) => {
        if (!new URL(url).pathname.endsWith("/sql/limits")) return { status: 200, json: [] };
        if (fail) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { status: 503, json: { code: "REQUEST_FAILED" } };
        }
        return { status: 200, json: sqlTestLimits };
      },
    );
    try {
      const dialog = tab.locator("dialog[open]");
      await dialog.getByRole("status").filter({ hasText: "SQL-Nutzung und Grenzen werden geladen" }).waitFor();
      expect(await dialog.locator(".k2b-skeleton").count()).toBe(6);
      expect(await dialog.getByText("1,8 GB", { exact: false }).count()).toBeGreaterThan(0);
      release?.();
      await dialog.getByRole("alert").filter({ hasText: "SQL-Nutzung und Grenzen konnten nicht geladen werden" }).waitFor();
      expect(await dialog.getByText("Nutzung konnte nicht geladen werden", { exact: true }).isVisible()).toBe(true);
      expect(await dialog.getByText("Noch nicht gemessen", { exact: true }).count()).toBe(0);
      fail = false;
      await dialog.getByRole("alert").getByRole("button").click();
      await dialog.getByText("16 KiB · 32 × 2 KiB", { exact: true }).waitFor();
      expect(await dialog.getByText("Nutzung konnte nicht geladen werden", { exact: true }).count()).toBe(0);
      expect(await dialog.locator(".k2b-skeleton").count()).toBe(0);
      await dialog.getByRole("tab", { name: "Leeren und löschen", exact: true }).click();
      expect(await dialog.locator('button[data-variant="danger"]').count()).toBe(0);
    } finally {
      release?.();
      await tab.close();
    }
  }
}, 60_000);
