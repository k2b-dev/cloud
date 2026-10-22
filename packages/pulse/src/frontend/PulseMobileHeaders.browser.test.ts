import { afterAll, beforeAll, expect, test } from "bun:test";
import { launchBrowser } from "../../../ui/test/browser";
import { buildWorkspaceHarness, origin, overviewWorkspaceFixture, renderWorkspaceSnapshot } from "./PulseWorkspace.browser-fixture";
import { dashboardTestDashboard, dashboardTestSnapshot } from "./workspace/dashboard-test-fixtures";
import { buildPulseWorkspaceHref } from "./workspace/routes";
import { sqlTestLimits } from "./workspace/sql-test-fixtures";
import type { PulseWorkspaceProps } from "./workspace/types";

let browser: Awaited<ReturnType<typeof launchBrowser>>;
let harness: Awaited<ReturnType<typeof buildWorkspaceHarness>>;
beforeAll(async () => {
  harness = await buildWorkspaceHarness();
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

const snapshot = (view: "overview" | "sources" | "sql"): PulseWorkspaceProps => ({
  ...overviewWorkspaceFixture,
  initialBases: overviewWorkspaceFixture.initialBases.map((base) => ({ ...base, description: "Telemetry for the shop" })),
  initialRouteState: { view, sourceId: "", ...(view === "sql" ? { sql: "SELECT :host", params: { host: "shop-01" } } : {}) },
  initialDashboards: { ...dashboardTestSnapshot, selected: null },
  initialSql: { limits: sqlTestLimits, query: null, error: null },
});

for (const view of ["overview", "sources", "sql"] as const) {
  test(`${view} composes its phone header before three chips and main, with SSR and first client parity`, async () => {
    const props = snapshot(view);
    const serverHtml = await renderWorkspaceSnapshot(props, "de", true);
    for (const width of [390, 900, 1440]) {
      const tab = await browser.newPage({ viewport: { width, height: 1000 } });
      try {
        await tab.clock.install({ time: new Date(props.initialNow!) });
        await tab.clock.pauseAt(new Date(props.initialNow!));
        await tab.route(`${origin}/api/**`, (route) => route.fulfill({ status: 500, json: { code: "UNEXPECTED" } }));
        await tab.route(`${origin}/app/pulse/**`, (route) =>
          route.fulfill({
            contentType: "text/html",
            body: harness(props, "de", width === 900, undefined, { serverHtml, deferMount: true, pageDocument: true }),
          }),
        );
        await tab.goto(`${origin}${buildPulseWorkspaceHref({ baseId: props.initialBaseId, state: props.initialRouteState })}`);
        await tab.evaluate(() => document.fonts.ready);
        const header = tab.locator(".pulse-workspace__mobile-header");
        const geometry = async () => {
          expect(await header.isVisible()).toBe(width < 768);
          if (width >= 768) return null;
          expect(await header.locator(".pulse-workspace__mobile-title").innerText()).toBe(
            view === "overview" ? "Übersicht" : view === "sources" ? "Quellen" : "SQL",
          );
          const nav = tab.locator(".pulse-workspace > nav");
          const main = tab.locator(".pulse-workspace .k2b-app-workspace__main");
          const [headBox, navBox, mainBox] = await Promise.all([header.boundingBox(), nav.boundingBox(), main.boundingBox()]);
          expect(headBox!.y + headBox!.height).toBeLessThanOrEqual(navBox!.y + 1);
          expect(navBox!.y + navBox!.height).toBeLessThanOrEqual(mainBox!.y + 1);
          for (const chip of [
            nav.getByRole("button", { name: /^Übersicht/ }),
            nav.getByRole("button", { name: "SQL", exact: true }),
            nav.getByRole("link", { name: dashboardTestDashboard.name, exact: true }),
          ]) {
            expect(await chip.isVisible()).toBe(true);
            const box = (await chip.boundingBox())!;
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(width);
          }
          expect(
            await header
              .getByRole("button", { name: view === "sources" ? "Neue Quelle in Laden" : "Mit KI fragen", exact: true })
              .isVisible(),
          ).toBe(true);
          return [headBox, navBox, mainBox];
        };
        const before = await geometry();
        await tab.evaluate(() => (window as unknown as { __pulseMount: () => void }).__pulseMount());
        await tab.locator('#root[data-mounted="true"]').waitFor();
        expect(await geometry()).toEqual(before);
        expect(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (width === 1440) {
          expect(await tab.locator(".pulse-sidebar__identity").innerText()).toBe("Pulse");
          expect(await tab.locator(".pulse-workspace .k2b-sidebar-switcher small").innerText()).toBe("Base · 3 Mitglieder");
        }
        if (view === "sources" && width === 390) {
          await header.getByRole("button", { name: "Neue Quelle in Laden", exact: true }).click();
          await tab.getByRole("dialog").waitFor();
          expect(await tab.locator(".pulse-source-picker").isVisible()).toBe(true);
        }
      } finally {
        await tab.close();
      }
    }
  }, 30_000);
}

test("the phone SQL action sends the live draft once, shows pending, and retries without remounting or draft loss", async () => {
  const props = snapshot("sql");
  const tab = await browser.newPage({ viewport: { width: 390, height: 1000 } });
  const launches: unknown[] = [];
  const response = Promise.withResolvers<void>();
  try {
    await tab.clock.install({ time: new Date(props.initialNow!) });
    await tab.clock.pauseAt(new Date(props.initialNow!));
    await tab.route(`${origin}/api/**`, async (route) => {
      if (route.request().url().endsWith("/api/ai/conversations")) {
        launches.push(route.request().postDataJSON());
        await response.promise;
        return route.fulfill({ status: 503, json: { code: "REQUEST_FAILED" } });
      }
      return route.fulfill({ status: 500, json: { code: "UNEXPECTED" } });
    });
    await tab.route(`${origin}/app/pulse/**`, (route) => route.fulfill({ contentType: "text/html", body: harness(props) }));
    await tab.goto(`${origin}${buildPulseWorkspaceHref({ baseId: props.initialBaseId, state: props.initialRouteState })}`);
    const editor = tab.getByRole("textbox", { name: "SQL", exact: true });
    await editor.fill("SELECT :host, :bucket");
    await editor.evaluate((element) => element.setAttribute("data-original-editor", "true"));
    await tab.getByRole("textbox", { name: ":host", exact: true }).fill("new-host");
    await tab.getByRole("textbox", { name: ":bucket", exact: true }).fill("300");
    const action = tab.locator(".pulse-workspace__mobile-header button[data-variant=ai]");
    await action.click();
    await tab.getByRole("button", { name: "Assistant wird geöffnet …", exact: true }).waitFor();
    expect(await action.isDisabled()).toBe(true);
    expect(launches).toHaveLength(1);
    const text = JSON.stringify(launches[0]);
    expect(text).toContain("SELECT :host, :bucket");
    expect(text).toContain("host = new-host");
    expect(text).toContain("bucket = 300");
    response.resolve();
    await tab.locator('[data-sql-region="status"]').filter({ hasText: "Der Assistant ließ sich nicht öffnen" }).waitFor();
    expect(await action.isEnabled()).toBe(true);
    const status = tab.locator('[data-sql-region="status"]');
    expect(await status.getByRole("button", { name: "Erneut versuchen", exact: true }).isEnabled()).toBe(true);
    const diagnosis = tab
      .locator('[data-sql-region="result"]')
      .getByRole("heading", { name: "Der Assistant ließ sich nicht öffnen", exact: true });
    expect(await diagnosis.getAttribute("class")).toContain("sr-only");
    expect(await diagnosis.locator("..").locator("p").innerText()).not.toBe("");
    await Promise.all([
      tab.waitForRequest(`${origin}/api/ai/conversations`),
      tab.getByRole("button", { name: "Erneut versuchen", exact: true }).click(),
    ]);
    expect(launches).toHaveLength(2);
    expect(await editor.inputValue()).toBe("SELECT :host, :bucket");
    expect(await editor.getAttribute("data-original-editor")).toBe("true");
    expect(await tab.getByRole("textbox", { name: ":host", exact: true }).inputValue()).toBe("new-host");
    expect(await tab.getByRole("textbox", { name: ":bucket", exact: true }).inputValue()).toBe("300");
  } finally {
    response.resolve();
    await tab.close();
  }
});

test("the phone All sheet keeps Sources and settings reachable without replacing the SQL draft", async () => {
  const props = snapshot("sql");
  const tab = await browser.newPage({ viewport: { width: 390, height: 1000 } });
  try {
    await tab.clock.install({ time: new Date(props.initialNow!) });
    await tab.clock.pauseAt(new Date(props.initialNow!));
    await tab.route(`${origin}/api/**`, (route) => route.fulfill({ status: 500, json: { code: "UNEXPECTED" } }));
    await tab.route(`${origin}/app/pulse/**`, (route) => route.fulfill({ contentType: "text/html", body: harness(props) }));
    await tab.goto(`${origin}${buildPulseWorkspaceHref({ baseId: props.initialBaseId, state: props.initialRouteState })}`);
    const editor = tab.getByRole("textbox", { name: "SQL", exact: true });
    await editor.fill("SELECT :host, 2");
    await editor.evaluate((element) => element.setAttribute("data-original-editor", "true"));
    const draftUrl = tab.url();
    await tab.locator(".pulse-workspace > nav").getByRole("button", { name: "Alle Laden", exact: true }).click();
    const sheet = tab.getByRole("dialog");
    expect(
      await sheet
        .locator('[data-variant="row"]')
        .filter({ hasText: /^Quellen/ })
        .isVisible(),
    ).toBe(true);
    await sheet.getByRole("button", { name: "Einstellungen", exact: true }).click();
    await tab.waitForURL((url) => url.searchParams.has("settings"));
    await tab.keyboard.press("Escape");
    await tab.waitForURL(draftUrl);
    await tab.keyboard.press("Escape");
    expect(await editor.inputValue()).toBe("SELECT :host, 2");
    expect(await editor.getAttribute("data-original-editor")).toBe("true");
  } finally {
    await tab.close();
  }
});

test("overview phone action reports launch failure and stays unavailable without an authorized snapshot", async () => {
  for (const mode of ["ready", "loading", "denied"] as const) {
    const props = {
      ...snapshot("overview"),
      ...(mode === "loading"
        ? { initialOverview: undefined }
        : mode === "denied"
          ? { initialOverview: { data: null, error: { code: "FORBIDDEN", message: "Denied" } } }
          : {}),
    };
    const tab = await browser.newPage({ viewport: { width: 390, height: 1000 } });
    try {
      await tab.clock.install({ time: new Date(props.initialNow!) });
      await tab.clock.pauseAt(new Date(props.initialNow!));
      await tab.route(`${origin}/api/**`, (route) => route.fulfill({ status: 503, json: { code: "REQUEST_FAILED" } }));
      await tab.route(`${origin}/app/pulse/**`, (route) => route.fulfill({ contentType: "text/html", body: harness(props, "de", true) }));
      await tab.goto(`${origin}/app/pulse/Lad001`);
      await tab.locator('#root[data-mounted="true"]').waitFor();
      const header = tab.locator(".pulse-workspace__mobile-header");
      const action = header.getByRole("button", { name: "Mit KI fragen", exact: true });
      if (mode === "ready") {
        await action.click();
        await tab.locator(".pulse-overview__assistant-feedback").filter({ hasText: "Assistant" }).waitFor();
        expect(await action.isEnabled()).toBe(true);
      } else {
        expect(await action.count()).toBe(0);
        if (mode === "denied") {
          const switcher = await header.locator(".k2b-sidebar-switcher").innerText();
          expect(switcher).toContain("Pulse");
          expect(switcher).not.toContain("Laden");
        }
      }
    } finally {
      await tab.close();
    }
  }
});
