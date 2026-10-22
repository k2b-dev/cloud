import { afterAll, beforeAll, expect, test } from "bun:test";
import { launchBrowser } from "../../../ui/test/browser";
import type { Dashboard } from "../dashboard-contracts";
import {
  baseOverviewFixture,
  buildWorkspaceHarness,
  origin,
  renderWorkspaceSnapshot,
  workspaceFixture,
} from "./PulseWorkspace.browser-fixture";
import type { DashboardPanelResult } from "./workspace/dashboard-client";
import {
  dashboardTestDashboard,
  dashboardTestKinds,
  dashboardTestNow,
  dashboardTestPanelResult,
  dashboardTestSnapshot,
} from "./workspace/dashboard-test-fixtures";
import { buildPulseWorkspaceHref, readWorkspacePathState } from "./workspace/routes";
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
// Reuse the real SSR document only for an identical route, permissions and data snapshot.
const serverSnapshots = new Map<string, Promise<string>>();
const serverSnapshot = (props: PulseWorkspaceProps) => {
  const key = JSON.stringify(props);
  let snapshot = serverSnapshots.get(key);
  if (!snapshot) {
    snapshot = renderWorkspaceSnapshot(props, "de", true);
    serverSnapshots.set(key, snapshot);
  }
  return snapshot;
};
type Reply = { status?: number; json: unknown; abort?: boolean; wait?: Promise<void> };
const open = async (
  options: {
    width?: number;
    dark?: boolean;
    dashboard?: Dashboard;
    public?: boolean;
    empty?: boolean;
    deferred?: Promise<void>;
    readOnly?: boolean;
    attention?: boolean;
    multipleAttention?: boolean;
    rootRoute?: boolean;
    listError?: boolean;
    now?: string;
    paginated?: boolean;
  } = {},
) => {
  const dashboard = options.dashboard ?? dashboardTestDashboard;
  const overview = {
    ...baseOverviewFixture,
    name: "Betrieb",
    readAt: dashboardTestNow,
    attention: options.attention
      ? {
          ...baseOverviewFixture.attention,
          items: [
            { ...baseOverviewFixture.attention.items[0]!, name: "Platte", key: "demo-db", severity: "critical" as const },
            ...(options.multipleAttention
              ? ["Sicherung", "Antwortzeit"].map((name, index) => ({
                  ...baseOverviewFixture.attention.items[0]!,
                  id: `fictional-attention-${index}`,
                  name,
                  key: null,
                }))
              : []),
          ],
        }
      : { items: [], total: 0, nextOffset: null },
  };
  let listResponse: Reply = { json: dashboardTestSnapshot };
  let overviewResponse: Reply = { json: overview };
  const tab = await browser.newPage({ viewport: { width: options.width ?? 1440, height: 1000 } });
  await tab.clock.install({ time: new Date(options.now ?? dashboardTestNow) });
  await tab.clock.pauseAt(new Date(options.now ?? dashboardTestNow));
  const requests: { path: string; body: unknown; key: string | undefined }[] = [];
  const panels = new Map<string, Reply>();
  let publication: Reply = { json: { href: "/app/pulse/public/fictional-public-token", revision: 4 } };
  let revoke: Reply = { json: { deleted: true, revision: 5 } };
  let assistant: Reply = { json: { id: "Chat01", draft: { content: [], revision: 1, updatedAt: null } } };
  await tab.route(`${origin}/api/**`, async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    const body = req.postData() ? req.postDataJSON() : null;
    requests.push({ path: req.url(), body, key: req.headers()["idempotency-key"] });
    if (path.includes("/panels/")) {
      if (options.deferred) await options.deferred;
      const id = decodeURIComponent(path.split("/").at(-1)!);
      const panel = dashboard.definition.panels.find((panel) => panel.id === id);
      if (!panel) return route.fulfill({ status: 404, json: { code: "NOT_FOUND" } });
      const reply = panels.get(id) ?? { json: dashboardTestPanelResult(panel) };
      if (reply.wait) await reply.wait;
      if (reply.abort) return route.abort("failed");
      return route.fulfill({ status: reply.status, json: reply.json });
    }
    if (path.endsWith("/dashboards")) return route.fulfill(listResponse);
    if (path.endsWith("/overview")) return route.fulfill(overviewResponse);
    if (path.endsWith("/publish")) return route.fulfill(publication);
    if (path.endsWith("/unpublish")) return route.fulfill(revoke);
    if (path === "/api/ai/conversations") return route.fulfill(assistant);
    return route.fulfill({ status: 500, json: { code: "UNEXPECTED" } });
  });
  await tab.route(`${origin}/app/assistant**`, (route) =>
    route.fulfill({ contentType: "text/html", body: "<main>Assistant draft</main>" }),
  );
  const makeProps = (url: string): PulseWorkspaceProps => ({
    ...workspaceFixture,
    initialNow: dashboardTestNow,
    initialOverview: { data: overview, error: null },
    initialBases: workspaceFixture.initialBases.map((base) => ({ ...base, name: "Betrieb" })),
    initialPermissions: { write: !options.readOnly, admin: !options.readOnly },
    initialRouteState: readWorkspacePathState(url, workspaceFixture.initialBaseId),
    initialDashboards: {
      ...dashboardTestSnapshot,
      selected: options.empty ? null : dashboard,
      items:
        options.empty || options.listError
          ? []
          : options.paginated
            ? dashboardTestSnapshot.items.filter((item) => item.id !== dashboard.id)
            : dashboardTestSnapshot.items,
      nextOffset: options.paginated ? 1 : null,
      error: options.listError ? { code: "REQUEST_FAILED", message: "Fictional list failure" } : null,
      total: options.empty ? 0 : 2,
    },
  });
  await tab.route(`${origin}/app/pulse/**`, async (route) => {
    const props = makeProps(route.request().url());
    const publicProps = options.public
      ? {
          token: "fictional-public-token",
          dashboard: {
            id: dashboard.id,
            name: dashboard.name,
            revision: dashboard.revision,
            panels: dashboard.definition.panels.map(({ sql: _sql, params: _params, ...panel }) => panel),
          },
          range: props.initialRouteState.dashboardRange ?? { range: "24h" as const },
          path: new URL(route.request().url()).pathname + new URL(route.request().url()).search,
        }
      : undefined;
    return route.fulfill({
      contentType: "text/html",
      body: harness(
        props,
        "de",
        options.dark ?? false,
        undefined,
        options.public ? undefined : { serverHtml: await serverSnapshot(props), deferMount: false, pageDocument: true },
        publicProps,
      ),
    });
  });
  await tab.goto(
    `${origin}${options.public ? "/app/pulse/public/fictional-public-token" : buildPulseWorkspaceHref({ baseId: workspaceFixture.initialBaseId, state: { view: "dashboards", dashboardId: options.rootRoute ? undefined : dashboard.id } })}`,
  );
  await tab.locator(".pulse-dashboard").waitFor();
  return {
    tab,
    requests,
    panels,
    listReply: (reply: Reply) => {
      listResponse = reply;
    },
    overviewReply: (reply: Reply) => {
      overviewResponse = reply;
    },
    publishReply: (reply: Reply) => {
      publication = reply;
    },
    revokeReply: (reply: Reply) => {
      revoke = reply;
    },
    assistantReply: (reply: Reply) => {
      assistant = reply;
    },
  };
};
const ready = async (tab: Awaited<ReturnType<typeof open>>["tab"]) => {
  await tab.locator('.pulse-dashboard__band[data-loading="false"]').waitFor();
  await tab.evaluate(() => document.fonts.ready);
};

test("approved 3-column layout, stat tiles, linked keyboard tooltips, phone/tablet and dark", async () => {
  for (const [width, dark] of [
    [1440, false],
    [820, false],
    [390, false],
    [1440, true],
    [390, true],
  ] as const) {
    const { tab } = await open({ width, dark, attention: true });
    try {
      await ready(tab);
      expect(await tab.locator(".pulse-dashboard__band").textContent()).toContain("Platte demo-db kritisch");
      const band = tab.locator(".pulse-dashboard__band");
      expect(await band.locator(".pulse-dashboard__status-dot").count()).toBe(1);
      expect(await band.locator(".pulse-dashboard__status-dot").evaluate((element) => getComputedStyle(element, "::before").width)).toBe(
        "8px",
      );
      expect(await band.textContent()).toContain("alle 60 s");
      expect(await band.locator(":scope > p").count()).toBe(1);
      const reference = tab.locator('[data-panel="e5"] .stdlib-chart-reference');
      expect(await tab.locator('[data-panel="e5"] .stdlib-chart-reference-label').textContent()).toBe("Alarm 2 %");
      expect(await reference.evaluate((element) => getComputedStyle(element).stroke)).toBe(
        await band.locator(".pulse-dashboard__status-dot").evaluate((element) => getComputedStyle(element).color),
      );

      await tab.screenshot({ path: `/tmp/pulse-dashboard-actual-${width}-${dark ? "dark" : "light"}.png`, fullPage: true });
      const traefik = tab.getByRole("region", { name: "Traefik", exact: true });
      const server = tab.getByRole("region", { name: "Server", exact: true });
      expect(await traefik.locator(".ti-router").count()).toBe(1);
      expect(await server.locator(".ti-server-2").count()).toBe(1);
      expect(await traefik.locator(".k2b-avatar").evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(
        await server.locator(".k2b-avatar").evaluate((el) => getComputedStyle(el).backgroundColor),
      );
      expect(await traefik.getByText("Quelle Traefik · Raster 5 Min.", { exact: true }).isVisible()).toBe(width !== 390);
      expect(await server.getByText("2 Quellen · Raster 5 Min.", { exact: true }).isVisible()).toBe(width !== 390);
      expect(await tab.locator("[data-panel]").count()).toBe(10);
      expect(await tab.locator(".pulse-dashboard__stats [data-panel]").count()).toBe(4);
      const panels = await Promise.all(["req", "e5", "p95"].map((id) => tab.locator(`[data-panel="${id}"]`).boundingBox()));
      if (width === 1440) {
        expect(panels[0]!.y).toBe(panels[1]!.y);
        expect(panels[1]!.y).toBe(panels[2]!.y);
        expect(Math.abs(panels[1]!.x - panels[0]!.x - panels[0]!.width - 32)).toBeLessThan(1);
      } else if (width === 390) expect(panels[0]!.y).toBeLessThan(panels[1]!.y);
      expect(await tab.locator('[data-panel="req"] .k2b-chart').evaluate((el) => el.getBoundingClientRect().height)).toBe(198);
      expect(await tab.getByRole("table").getByText("demo-web").count()).toBe(1);
      expect(await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      const chart = tab.locator('[data-panel="req"] .k2b-chart');
      const ticksOverlap = await chart.locator('svg text.stdlib-chart-tick-label[text-anchor="middle"]').evaluateAll((labels) => {
        const boxes = labels.filter((label) => label.textContent?.trim()).map((label) => label.getBoundingClientRect());
        return boxes.some((box, index) => index > 0 && box.left < boxes[index - 1]!.right);
      });
      expect(ticksOverlap).toBe(false);
      await chart.focus();
      await chart.press("ArrowRight");
      await tab.locator('[data-panel="req"] [role="tooltip"]:popover-open').waitFor();
      expect(await tab.locator('[data-panel="e5"] [data-inspected]').count()).toBeGreaterThan(0);
      await chart.press("Escape");
      await tab.getByRole("button", { name: "So gerechnet: Anfragen je Dienst", exact: true }).click();
      expect(await tab.locator("#pulse-panel-sql-req details").getAttribute("open")).not.toBeNull();
      expect(await tab.locator("#pulse-panel-sql-req code").textContent()).toContain("SELECT time");
      await tab.locator("#pulse-panel-sql-req summary").click();
      expect(
        await tab
          .getByRole("button", { name: "So gerechnet: Anfragen je Dienst", exact: true })
          .evaluate((element) => element === document.activeElement),
      ).toBe(true);
    } finally {
      await tab.close();
    }
  }
}, 60_000);

test("all five kinds render complete values and two-column sections without page overflow", async () => {
  for (const width of [1440, 390]) {
    const { tab } = await open({ dashboard: dashboardTestKinds, width });
    try {
      await ready(tab);
      expect(await tab.locator('[data-kind="bar"] .k2b-chart').count()).toBe(1);
      expect(await tab.locator('[data-kind="funnel"] .k2b-chart').count()).toBe(1);
      const a = await tab.locator('[data-panel="visits"]').boundingBox(),
        b = await tab.locator('[data-panel="pages"]').boundingBox();
      expect(width === 1440 ? a!.y === b!.y : a!.y < b!.y).toBe(true);
      expect(await tab.getByRole("table").getByText("1.200").count()).toBe(1);
      expect(await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      const funnel = tab.locator('[data-kind="funnel"] .k2b-chart');
      // Focus must not still be scrolling when inspection opens: outside scroll closes it.
      await funnel.scrollIntoViewIfNeeded();
      await tab.clock.runFor(32);
      await tab.waitForFunction(() => {
        const box = document.querySelector('[data-kind="funnel"] .k2b-chart')?.getBoundingClientRect();
        return box && box.top >= 0 && box.bottom <= innerHeight;
      });
      await funnel.focus();
      await funnel.press("ArrowRight");
      await tab.locator('[data-kind="funnel"] [role="tooltip"]:popover-open').waitFor();
      expect(await tab.locator('[data-kind="funnel"] [role="tooltip"]:popover-open').textContent()).toContain("vom ersten Schritt");
    } finally {
      await tab.close();
    }
  }
}, 30_000);

test("range presets reload their selected value and Back restores the prior range; custom range is reloadable", async () => {
  const { tab, requests } = await open();
  try {
    await ready(tab);
    await tab.getByRole("link", { name: "7 Tage", exact: true }).click();
    await ready(tab);
    expect(new URL(tab.url()).searchParams.get("range")).toBe("7d");
    expect(await tab.getByRole("link", { name: "7 Tage", exact: true }).getAttribute("aria-current")).toBe("true");
    await tab.reload();
    await ready(tab);
    expect(new URL(tab.url()).searchParams.get("range")).toBe("7d");
    await tab.goBack();
    await ready(tab);
    expect(new URL(tab.url()).searchParams.get("range")).toBe("24h");
    await tab.getByRole("button", { name: "Eigener Zeitraum", exact: true }).click();
    await tab.getByRole("button", { name: "Zeitraum übernehmen", exact: true }).click();
    expect(await tab.getByRole("alert").count()).toBe(1);
    await tab.goto(
      `${origin}/app/pulse/Lad001/dashboards/Dash01?range=24h&from=2026-10-01T00%3A00%3A00.000Z&to=2026-10-08T00%3A00%3A00.000Z`,
    );
    await ready(tab);
    expect(await tab.getByRole("button", { name: "Zeitraum übernehmen", exact: true }).count()).toBe(1);
    const custom = tab.getByRole("button", { name: "Eigener Zeitraum", exact: true });
    expect(await tab.getByRole("link", { name: "Eigener Zeitraum", exact: true }).getAttribute("aria-current")).toBe("true");
    expect(await tab.getByRole("link", { name: "Eigener Zeitraum", exact: true }).getAttribute("data-selected")).toBe("true");
    await custom.click();
    expect(await tab.getByRole("link", { name: "Eigener Zeitraum", exact: true }).getAttribute("aria-current")).toBe("true");
    expect(await custom.getAttribute("aria-expanded")).toBe("false");
    await custom.click();
    await tab.getByRole("button", { name: "Von (UTC)", exact: true }).click();
    const picker = tab.locator(".k2b-date-popover:popover-open");
    await picker.getByRole("textbox").fill("08:30");
    await picker.locator(".k2b-date-apply").click();
    await tab.getByRole("button", { name: "Zeitraum übernehmen", exact: true }).click();
    await ready(tab);
    expect(new URL(tab.url()).searchParams.get("from")).toBe("2026-10-01T08:30:00.000Z");
    expect(
      requests
        .filter((req) => req.path.includes("/panels/"))
        .some((req) => new URL(req.path).searchParams.get("to") === "2026-10-08T00:00:00.000Z"),
    ).toBe(true);
  } finally {
    await tab.close();
  }
}, 60_000);

test("loading retains panel slots, per-panel failures retry, outages retain last-good values, revoked access clears them", async () => {
  let release: (() => void) | undefined;
  const deferred = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { tab, panels } = await open({ deferred });
  try {
    await tab.locator('[data-panel="req"] .k2b-skeleton').waitFor();
    const before = await tab.locator('[data-panel="req"]').boundingBox();
    panels.set("p95", {
      json: {
        panelId: "p95",
        status: "error",
        error: "TIME_LIMIT",
        lastGood: null,
        nextRefreshAt: "2026-10-20T14:33:00.000Z",
      } satisfies DashboardPanelResult,
    });
    release!();
    await ready(tab);
    expect(await tab.locator('[data-panel="p95"] [role="alert"]').textContent()).toContain("zu lange");
    expect(
      await tab
        .locator('[data-panel="req"]')
        .boundingBox()
        .then((box) => box!.width),
    ).toBe(before!.width);
    panels.delete("p95");
    await tab.locator('[data-panel="p95"]').getByRole("button", { name: "Erneut versuchen", exact: true }).click();
    await tab.locator('[data-panel="p95"] .k2b-chart').waitFor();
    panels.set("req", {
      json: {
        panelId: "req",
        status: "error",
        error: "STORE_UNAVAILABLE",
        lastGood: null,
        nextRefreshAt: "2026-10-20T14:34:00.000Z",
      } satisfies DashboardPanelResult,
    });
    await tab.clock.runFor(60000);
    await tab.locator('.pulse-dashboard__band[data-error="true"]').waitFor();
    expect(await tab.locator('[data-panel="req"] .k2b-chart').count()).toBe(1);
    expect(await tab.locator('[data-panel="req"]').textContent()).toContain("Letzter erfolgreicher Stand");
    panels.set("requests-now", { status: 403, json: { code: "FORBIDDEN" } });
    await tab.locator(".pulse-dashboard__band").getByRole("button", { name: "Erneut versuchen", exact: true }).click();
    await tab.getByText("Dashboard nicht verfügbar", { exact: true }).waitFor();
    expect(await tab.locator("[data-panel]").count()).toBe(0);
  } finally {
    release?.();
    await tab.close();
  }
}, 30_000);

test("sharing reviews every column, confirms publish and revoke, and recovers a lost response with the same key", async () => {
  for (const width of [1440, 390]) {
    const { tab, requests, publishReply } = await open({ dashboard: dashboardTestKinds, width });
    try {
      await ready(tab);
      await tab.getByRole("button", { name: "Teilen", exact: true }).click();
      const dialog = tab.locator("dialog[open]").last();
      expect(await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      expect(await dialog.getByRole("button", { name: "Dashboard veröffentlichen", exact: true }).isDisabled()).toBe(true);
      for (const checkbox of await dialog.getByRole("checkbox").all()) await checkbox.check();
      publishReply({ status: 503, json: { code: "STORE_UNAVAILABLE" } });
      await dialog.getByRole("button", { name: "Dashboard veröffentlichen", exact: true }).click();
      await tab.locator("dialog[open]").last().getByRole("button", { name: "Dashboard veröffentlichen", exact: true }).click();
      await dialog.getByRole("alert").waitFor();
      await tab.reload();
      await ready(tab);
      await tab.getByRole("button", { name: "Teilen", exact: true }).click();
      publishReply({ json: { href: "/app/pulse/public/fictional-public-token", revision: 4 } });
      await dialog.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
      await dialog.getByRole("textbox", { name: "Öffentlicher Link", exact: true }).waitFor();
      expect(await dialog.getByRole("button", { name: "Dashboard veröffentlichen", exact: true }).isDisabled()).toBe(true);
      expect(await dialog.textContent()).not.toContain("Der bisherige Link funktioniert danach nicht mehr");
      const publishes = requests.filter((req) => new URL(req.path).pathname.endsWith("/publish"));
      expect(publishes).toHaveLength(2);
      expect(publishes[0]!.key).toBe(publishes[1]!.key);
      expect(publishes[0]!.body).toEqual({
        expectedRevision: 3,
        columns: Object.fromEntries(dashboardTestKinds.definition.panels.map((panel) => [panel.id, panel.columns])),
      });
      await dialog.getByRole("button", { name: "Öffentlichen Link widerrufen", exact: true }).click();
      await tab.locator("dialog[open]").last().getByRole("button", { name: "Öffentlichen Link widerrufen", exact: true }).click();
      await dialog.getByRole("button", { name: "Dashboard veröffentlichen", exact: true }).waitFor();
      expect(requests.find((req) => new URL(req.path).pathname.endsWith("/unpublish"))?.body).toEqual({ expectedRevision: 4 });
      expect(await dialog.getByRole("textbox", { name: "Öffentlicher Link", exact: true }).count()).toBe(0);
    } finally {
      await tab.close();
    }
  }
}, 30_000);

test("public display has no SQL, parameters, share or Assistant and rechecks the token on every panel read", async () => {
  const { tab, requests, panels } = await open({ public: true, width: 390 });
  try {
    await ready(tab);
    expect(await tab.locator(".pulse-dashboard__sql").count()).toBe(0);
    expect(await tab.getByRole("button", { name: "Teilen", exact: true }).count()).toBe(0);
    expect(await tab.getByRole("button", { name: "Mit KI fragen", exact: true }).count()).toBe(0);
    expect(await tab.content()).not.toContain("fictional-private-host");
    expect(await tab.content()).not.toContain("SELECT time");
    expect(requests.every((req) => new URL(req.path).pathname.startsWith("/api/pulse/public/fictional-public-token/panels/"))).toBe(true);
    panels.set("requests-now", { status: 404, json: { code: "NOT_FOUND" } });
    await tab.clock.runFor(60000);
    await tab.getByText("Dashboard nicht verfügbar", { exact: true }).waitFor();
    expect(await tab.locator("[data-panel]").count()).toBe(0);
  } finally {
    await tab.close();
  }
}, 30_000);

test("empty dashboards lead to SQL or an unsent Assistant draft; dashboard Assistant preserves both resource attachments", async () => {
  const empty = await open({ empty: true });
  try {
    await empty.tab.getByRole("heading", { name: "Noch kein Dashboard", exact: true }).waitFor();
    expect(await empty.tab.getByRole("link", { name: "SQL-Konsole öffnen", exact: true }).getAttribute("href")).toBe(
      "/app/pulse/Lad001/sql",
    );
    await empty.tab.getByRole("button", { name: "Mit KI fragen", exact: true }).click();
    await empty.tab.waitForURL("**/app/assistant?conversation=Chat01");
    expect(empty.requests.filter((req) => new URL(req.path).pathname === "/api/ai/conversations")).toHaveLength(1);
  } finally {
    await empty.tab.close();
  }
  const current = await open();
  try {
    await ready(current.tab);
    current.assistantReply({ status: 503, json: { message: "offline" } });
    await current.tab.getByRole("button", { name: "Mit KI fragen", exact: true }).click();
    await current.tab.getByRole("alert").waitFor();
    expect(await current.tab.locator('[data-panel="req"] .k2b-chart').count()).toBe(1);
    current.assistantReply({ json: { id: "Chat01", draft: { content: [], revision: 1, updatedAt: null } } });
    await current.tab.getByRole("alert").getByRole("button", { name: "Erneut versuchen", exact: true }).click();
    await current.tab.waitForURL("**/app/assistant?conversation=Chat01");
    const launch = current.requests.filter((req) => new URL(req.path).pathname === "/api/ai/conversations").at(-1)!;
    expect(launch.body).toMatchObject({
      skills: ["cloud-pulse"],
      draft: {
        content: [
          { type: "text" },
          { type: "resource", ref: { type: "pulse.base", id: "Lad001" } },
          { type: "resource", ref: { type: "pulse.dashboard", id: "Dash01" } },
        ],
      },
    });
  } finally {
    await current.tab.close();
  }
}, 30_000);

test("empty panel data has visible feedback and readers keep SQL and Assistant without write controls", async () => {
  let release: (() => void) | undefined;
  const deferred = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { tab, panels } = await open({ readOnly: true, deferred });
  try {
    const panel = dashboardTestDashboard.definition.panels[4]!;
    const result = dashboardTestPanelResult(panel);
    panels.set(panel.id, { json: { ...result, lastGood: { ...result.lastGood!, data: { ...result.lastGood!.data, rows: [] } } } });
    release?.();
    await ready(tab);
    expect(await tab.locator(`[data-panel="${panel.id}"]`).textContent()).toContain("Keine Werte in diesem Zeitraum");
    expect(await tab.getByRole("button", { name: "Teilen", exact: true }).count()).toBe(0);
    expect(await tab.getByRole("button", { name: "Mit KI fragen", exact: true }).count()).toBe(1);
    expect(await tab.getByRole("button", { name: "So gerechnet: Anfragen je Dienst", exact: true }).count()).toBe(1);
  } finally {
    release?.();
    await tab.close();
  }
}, 30_000);

test("canceling publication writes nothing; stale revisions require an explicit reload", async () => {
  const { tab, requests, publishReply } = await open({ dashboard: dashboardTestKinds });
  try {
    await ready(tab);
    await tab.getByRole("button", { name: "Teilen", exact: true }).click();
    const dialog = tab.locator("dialog[open]").first();
    for (const checkbox of await dialog.getByRole("checkbox").all()) await checkbox.check();
    await dialog.getByRole("button", { name: "Dashboard veröffentlichen", exact: true }).click();
    await tab.locator("dialog[open]").last().getByRole("button", { name: "Abbrechen", exact: true }).click();
    expect(requests.filter((req) => new URL(req.path).pathname.endsWith("/publish"))).toHaveLength(0);
    publishReply({ status: 409, json: { code: "CONFLICT" } });
    await dialog.getByRole("button", { name: "Dashboard veröffentlichen", exact: true }).click();
    await tab.locator("dialog[open]").last().getByRole("button", { name: "Dashboard veröffentlichen", exact: true }).click();
    await dialog.getByRole("alert").waitFor();
    expect(await dialog.getByRole("button", { name: "Dashboard veröffentlichen", exact: true }).isDisabled()).toBe(true);
    expect(await dialog.getByRole("button", { name: "Dashboard neu laden", exact: true }).count()).toBe(1);
  } finally {
    await tab.close();
  }
}, 30_000);

test("the actual SSR page and first client render preserve dashboard structure inside the Cloud shell", async () => {
  for (const width of [1440, 820, 390]) {
    const props: PulseWorkspaceProps = {
      ...workspaceFixture,
      initialNow: dashboardTestNow,
      initialBases: workspaceFixture.initialBases.map((base) => ({ ...base, name: "Betrieb" })),
      initialRouteState: { view: "dashboards", sourceId: "", dashboardId: dashboardTestDashboard.id, dashboardRange: { range: "24h" } },
      initialDashboards: dashboardTestSnapshot,
      initialOverview: { data: { ...baseOverviewFixture, attention: { items: [], total: 0, nextOffset: null } }, error: null },
    };
    const serverHtml = await serverSnapshot(props);
    const tab = await browser.newPage({ viewport: { width, height: 1000 } });
    try {
      await tab.clock.install({ time: new Date(dashboardTestNow) });
      await tab.clock.pauseAt(new Date(dashboardTestNow));
      await tab.route(`${origin}/api/**`, (route) => {
        const id = new URL(route.request().url()).pathname.split("/").at(-1);
        const panel = dashboardTestDashboard.definition.panels.find((panel) => panel.id === id);
        return route.fulfill(panel ? { json: dashboardTestPanelResult(panel) } : { json: props.initialOverview!.data });
      });
      await tab.route(`${origin}/app/pulse/**`, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: harness(props, "de", false, undefined, { serverHtml, deferMount: true, pageDocument: true }),
        }),
      );
      await tab.goto(`${origin}/app/pulse/Lad001/dashboards/Dash01?range=24h`);
      await tab.waitForFunction(() => document.fonts.status === "loaded");
      const shellGeometry = () => tab.locator(".pulse-dashboard").evaluate((element) => element.getBoundingClientRect().left);
      const mobileGeometry = async () => {
        const header = tab.locator(".pulse-workspace__mobile-header");
        const sidebar = tab.locator(".pulse-workspace > .k2b-app-workspace__sidebar");
        const main = tab.locator(".pulse-workspace > .k2b-app-workspace__content");
        const switcher = header.locator(".k2b-sidebar-switcher__trigger");
        const [headBox, navBox, mainBox, switchBox] = await Promise.all([
          header.boundingBox(),
          sidebar.boundingBox(),
          main.boundingBox(),
          switcher.boundingBox(),
        ]);
        expect(headBox).not.toBeNull();
        expect(switchBox!.y).toBeLessThan(navBox!.y);
        expect(headBox!.y + headBox!.height).toBeLessThanOrEqual(navBox!.y + 1);
        expect(navBox!.y + navBox!.height).toBeLessThanOrEqual(mainBox!.y + 1);
        const chips = [
          sidebar.getByRole("button", { name: "Übersicht", exact: true }),
          sidebar.getByRole("button", { name: "SQL", exact: true }),
          sidebar.getByRole("link", { name: dashboardTestDashboard.name, exact: true }),
        ];
        for (const chip of chips) {
          const box = await chip.boundingBox();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(width);
          expect(box!.y).toBeLessThan(mainBox!.y);
        }
        return { headerTop: headBox!.y, sidebarTop: navBox!.y, mainTop: mainBox!.y };
      };
      const serverMobileGeometry = width < 768 ? await mobileGeometry() : null;
      const serverLeft = await shellGeometry();
      if (width === 1440) {
        expect(Math.abs(serverLeft - 312)).toBeLessThanOrEqual(1);
        expect(await tab.locator(".k2b-app-workspace__sidebar").evaluate((element) => element.getBoundingClientRect().width)).toBe(236);
        expect(await tab.locator('img[src="/branding/logo"]').count()).toBe(0);
        expect(await tab.locator('img[alt="Logo"]').evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      }
      const panels = tab.locator("[data-panel]");
      const before = await panels.evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label")));
      expect(before).toHaveLength(10);
      expect(await tab.getByRole("heading", { name: dashboardTestDashboard.name, exact: true }).count()).toBe(1);
      await tab.evaluate(() => (window as unknown as { __pulseMount: () => void }).__pulseMount());
      await ready(tab);
      expect(await shellGeometry()).toBe(serverLeft);
      if (serverMobileGeometry) expect(await mobileGeometry()).toEqual(serverMobileGeometry);
      const header = tab.locator(".pulse-dashboard > .k2b-panel-header");
      expect(await header.locator("h1").textContent()).toBe(dashboardTestDashboard.name);
      expect(await header.evaluate((element) => element.getBoundingClientRect().height > 1)).toBe(false);
      if (width < 768) {
        const mobile = tab.locator(".pulse-workspace__mobile-header");
        expect(await mobile.isVisible()).toBe(true);
        expect(await mobile.textContent()).toContain(dashboardTestDashboard.name);
      }
      if (width === 1440)
        expect(
          Math.abs((await tab.locator(".pulse-dashboard").evaluate((element) => element.getBoundingClientRect().left)) - 312),
        ).toBeLessThanOrEqual(1);
      expect(await panels.evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label")))).toEqual(before);
      expect(await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      await tab.screenshot({ path: `/tmp/pulse-dashboard-shell-${width}-light.png`, fullPage: true });
    } finally {
      await tab.close();
    }
  }
}, 30_000);

test("metadata read failures remain visible with retry and metadata access loss clears the dashboard", async () => {
  const { tab, overviewReply } = await open();
  try {
    await ready(tab);
    overviewReply({ status: 503, json: { code: "STORE_UNAVAILABLE" } });
    await tab.clock.runFor(60000);
    const notice = tab.getByRole("alert");
    await notice.waitFor();
    expect(await tab.locator('[data-panel="req"] .k2b-chart').count()).toBe(1);
    overviewReply({ status: 403, json: { code: "FORBIDDEN" } });
    await notice.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
    await tab.getByText("Dashboard nicht verfügbar", { exact: true }).waitFor();
    expect(await tab.locator("[data-panel]").count()).toBe(0);
    expect(await tab.getByRole("button", { name: "Teilen", exact: true }).count()).toBe(0);
  } finally {
    await tab.close();
  }
}, 30_000);

test("server admission waiting keeps a loading state until the shared result becomes available", async () => {
  let release: (() => void) | undefined;
  const deferred = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { tab, panels, requests } = await open({ deferred, now: "2026-10-20T14:32:55.000Z" });
  try {
    panels.set("req", {
      json: {
        panelId: "req",
        status: "waiting",
        error: null,
        lastGood: null,
        nextRefreshAt: "2026-10-20T14:33:00.000Z",
      } satisfies DashboardPanelResult,
    });
    release?.();
    await tab.locator('[data-panel="req"][aria-busy="false"] .k2b-skeleton').waitFor();
    expect(await tab.locator(".pulse-dashboard__band").getAttribute("data-loading")).toBe("true");
    panels.delete("req");
    await tab.locator('[data-panel="hosts"][aria-busy="false"] .pulse-dashboard__table').waitFor();
    const before = requests.filter((request) => request.path.includes("/panels/")).length;
    await tab.clock.runFor(4999);
    expect(requests.filter((request) => request.path.includes("/panels/")).length).toBe(before);
    await tab.clock.runFor(1);
    await ready(tab);
    expect(requests.filter((request) => request.path.includes("/panels/")).length).toBe(before + 1);
    expect(await tab.locator('[data-panel="req"] .k2b-chart').count()).toBe(1);
  } finally {
    release?.();
    await tab.close();
  }
}, 30_000);

test("SQL keeps the same 236px sidebar and 312px content origin in SSR and the browser", async () => {
  const props: PulseWorkspaceProps = {
    ...workspaceFixture,
    initialNow: dashboardTestNow,
    initialRouteState: { view: "sql", sourceId: "" },
    initialDashboards: dashboardTestSnapshot,
    initialOverview: { data: { ...baseOverviewFixture, attention: { items: [], total: 0, nextOffset: null } }, error: null },
  };
  const serverHtml = await serverSnapshot(props);
  const tab = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  try {
    await tab.clock.install({ time: new Date(dashboardTestNow) });
    await tab.clock.pauseAt(new Date(dashboardTestNow));
    await tab.route(`${origin}/api/**`, (route) => route.fulfill({ json: props.initialOverview!.data }));
    await tab.route(`${origin}/app/pulse/**`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: harness(props, "de", false, undefined, { serverHtml, deferMount: true, pageDocument: true }),
      }),
    );
    await tab.goto(`${origin}/app/pulse/Lad001/sql`);
    await tab.waitForFunction(() => document.fonts.status === "loaded");
    const contentLeft = () =>
      tab
        .locator(".k2b-app-workspace__main")
        .evaluate((element) => element.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(element).paddingLeft));
    expect(Math.abs((await contentLeft()) - 312)).toBeLessThanOrEqual(1);
    await tab.evaluate(() => (window as unknown as { __pulseMount: () => void }).__pulseMount());
    await tab.locator('#root[data-mounted="true"]').waitFor();
    expect(Math.abs((await contentLeft()) - 312)).toBeLessThanOrEqual(1);
    expect(await tab.getByRole("heading", { name: "Neue Abfrage · Laden", exact: true }).count()).toBe(1);
  } finally {
    await tab.close();
  }
}, 30_000);

test("warm refresh keeps attention and last-good time, including another viewer's refresh lease", async () => {
  const { tab, panels } = await open({ attention: true, multipleAttention: true, width: 390 });
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await ready(tab);
    const band = tab.locator(".pulse-dashboard__band");
    const before = await band.textContent();
    panels.set("requests-now", {
      wait,
      json: { ...dashboardTestPanelResult(dashboardTestDashboard.definition.panels[0]!), status: "refreshing", lastGood: null },
    });
    await tab.clock.runFor(60000);
    await tab.locator('[data-panel="requests-now"][aria-busy="true"]').waitFor();
    expect(await band.getAttribute("data-loading")).toBe("false");
    expect(await band.textContent()).toBe(before);
    const lineStarts = await band.locator("p").evaluate((paragraph) => {
      const starts = new Map<number, string>();
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        for (let index = 0; index < (node.textContent?.length ?? 0); index++) {
          const character = node.textContent![index]!;
          if (!character.trim()) continue;
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + 1);
          const top = Math.round(range.getBoundingClientRect().top);
          if (!starts.has(top)) starts.set(top, character);
        }
        node = walker.nextNode();
      }
      return [...starts.values()];
    });
    expect(lineStarts).not.toContain("·");
    release();
    await tab.locator('[data-panel="requests-now"][aria-busy="false"]').waitFor();
    expect(await band.getAttribute("data-loading")).toBe("false");
    expect(await band.textContent()).toBe(before);
  } finally {
    release();
    await tab.close();
  }
}, 30_000);

test("network failure preserves values and offers recovery without claiming a data store outage", async () => {
  const { tab, panels } = await open();
  try {
    await ready(tab);
    panels.set("req", { abort: true, json: null });
    await tab.clock.runFor(60000);
    const panel = tab.locator('[data-panel="req"]');
    await panel.getByRole("alert").waitFor();
    expect(await panel.locator(".k2b-chart").count()).toBe(1);
    expect(await tab.locator(".pulse-dashboard__band").getAttribute("data-error")).toBe("false");
    expect(await panel.textContent()).not.toContain("Pulse erreicht den Datenspeicher nicht");
    panels.delete("req");
    await panel.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
    await panel.getByRole("alert").waitFor({ state: "detached" });
  } finally {
    await tab.close();
  }
}, 30_000);

test("terminal publication rejections clear the receipt and require reload; timeouts and throttling retain retry", async () => {
  for (const status of [400, 413, 422, 408, 429]) {
    const { tab, publishReply } = await open({ dashboard: dashboardTestKinds });
    try {
      await ready(tab);
      await tab.getByRole("button", { name: "Teilen", exact: true }).click();
      const dialog = tab.locator("dialog[open]").first();
      for (const checkbox of await dialog.getByRole("checkbox").all()) await checkbox.check();
      publishReply({ status, json: { code: "REQUEST_FAILED" } });
      await dialog.getByRole("button", { name: "Dashboard veröffentlichen", exact: true }).click();
      await tab.locator("dialog[open]").last().getByRole("button", { name: "Dashboard veröffentlichen", exact: true }).click();
      await dialog.getByRole("alert").waitFor();
      const retryable = status === 408 || status === 429;
      expect(await tab.evaluate(() => sessionStorage.getItem("pulse:dashboard-publication:Lad001:Dash02") !== null)).toBe(retryable);
      expect(await dialog.getByRole("button", { name: "Dashboard neu laden", exact: true }).count()).toBe(retryable ? 0 : 1);
      expect(await dialog.getByRole("button", { name: "Erneut versuchen", exact: true }).count()).toBe(retryable ? 1 : 0);
      if (!retryable) {
        await dialog.getByRole("button", { name: "Dashboard neu laden", exact: true }).click();
        await ready(tab);
        await tab.getByRole("button", { name: "Teilen", exact: true }).click();
        expect(await tab.locator("dialog[open]").getByRole("button", { name: "Erneut versuchen", exact: true }).count()).toBe(0);
      }
    } finally {
      await tab.close();
    }
  }
}, 60_000);

test("republishing an existing dashboard warns in both the review and the final confirmation", async () => {
  const { tab, requests } = await open({ dashboard: { ...dashboardTestKinds, published: true } });
  try {
    await ready(tab);
    await tab.getByRole("button", { name: "Teilen", exact: true }).click();
    const dialog = tab.locator("dialog[open]").first();
    expect(await dialog.textContent()).toContain("Der bisherige Link funktioniert danach nicht mehr");
    for (const checkbox of await dialog.getByRole("checkbox").all()) await checkbox.check();
    await dialog.getByRole("button", { name: "Dashboard veröffentlichen", exact: true }).click();
    const confirmation = tab.locator("dialog[open]").last();
    expect(await confirmation.textContent()).toContain("Der bisherige Link funktioniert danach nicht mehr");
    await confirmation.getByRole("button", { name: "Abbrechen", exact: true }).click();
    expect(requests.filter((request) => request.path.includes("/publish"))).toHaveLength(0);
  } finally {
    await tab.close();
  }
}, 30_000);

test("sidebar list errors distinguish failure from emptiness and retry the first page", async () => {
  for (const width of [1440, 390]) {
    const { tab, requests, listReply } = await open({ width, listError: true });
    try {
      await ready(tab);
      if (width === 390) await tab.getByRole("button", { name: "Alle Betrieb", exact: true }).click();
      const navigation = width === 390 ? tab.locator(".k2b-app-workspace__sidebar-sheet") : tab.locator(".k2b-app-workspace__sidebar");
      expect(await navigation.getByText("Noch kein Dashboard", { exact: true }).count()).toBe(0);
      expect(await navigation.getByRole("alert").count()).toBe(1);
      listReply({ status: 503, json: { code: "REQUEST_FAILED" } });
      await navigation.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
      await navigation.getByRole("button", { name: "Erneut versuchen", exact: true }).waitFor({ state: "visible" });
      listReply({ json: { items: dashboardTestSnapshot.items, total: 2, nextOffset: null } });
      await navigation.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
      await navigation.getByRole("link", { name: dashboardTestDashboard.name, exact: true }).waitFor();
      expect(await navigation.getByRole("alert").count()).toBe(0);
      expect(
        requests
          .filter((request) => new URL(request.path).pathname.endsWith("/dashboards"))
          .every((request) => new URL(request.path).searchParams.get("offset") === "0"),
      ).toBe(true);
      if (width === 390) await tab.locator("dialog[open]").getByRole("button", { name: "Schließen", exact: true }).click();
    } finally {
      await tab.close();
    }
  }
}, 45_000);

test("range navigation from the dashboard collection pins the displayed dashboard", async () => {
  const { tab } = await open({ rootRoute: true });
  try {
    await ready(tab);
    expect(new URL(tab.url()).pathname).toBe("/app/pulse/Lad001/dashboards");
    expect(await tab.getByRole("link", { name: "7 Tage", exact: true }).getAttribute("href")).toBe(
      "/app/pulse/Lad001/dashboards/Dash01?range=7d",
    );
    await tab.getByRole("link", { name: "7 Tage", exact: true }).click();
    await ready(tab);
    expect(new URL(tab.url()).pathname).toBe("/app/pulse/Lad001/dashboards/Dash01");
    await tab.getByRole("button", { name: "Eigener Zeitraum", exact: true }).click();
    expect(await tab.getByRole("button", { name: "Eigener Zeitraum", exact: true }).getAttribute("aria-expanded")).toBe("true");
  } finally {
    await tab.close();
  }
}, 30_000);

test("hidden dashboards stop polling and refresh when the user returns", async () => {
  const { tab, requests } = await open();
  try {
    await ready(tab);
    expect(await tab.locator(".pulse-dashboard__band").textContent()).toContain("alle 60 s");
    await tab.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const before = requests.filter((request) => request.path.includes("/panels/")).length;
    await tab.clock.runFor(120000);
    expect(requests.filter((request) => request.path.includes("/panels/")).length).toBe(before);
    const resumed = tab.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/panels/hosts"));
    await tab.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await tab.clock.runFor(1);
    await resumed;
    await tab.waitForFunction(() => document.querySelector('[data-panel="hosts"]')?.getAttribute("aria-busy") === "false");
    expect(requests.filter((request) => request.path.includes("/panels/")).length).toBeGreaterThan(before);
  } finally {
    await tab.close();
  }
}, 30_000);

test("access loss closes an open sharing dialog and prevents publication", async () => {
  for (const cause of ["metadata", "panel"] as const) {
    const { tab, panels, requests, overviewReply } = await open();
    try {
      await ready(tab);
      await tab.getByRole("button", { name: "Teilen", exact: true }).click();
      const dialog = tab.locator("dialog[open]");
      await dialog.waitFor();
      if (cause === "metadata") overviewReply({ status: 403, json: { code: "FORBIDDEN" } });
      else panels.set("requests-now", { status: 403, json: { code: "FORBIDDEN" } });
      await tab.clock.runFor(60000);
      await tab.getByText("Dashboard nicht verfügbar", { exact: true }).waitFor();
      await dialog.waitFor({ state: "detached" });
      expect(requests.filter((request) => request.path.includes("/publish"))).toHaveLength(0);
    } finally {
      await tab.close();
    }
  }
}, 30_000);

test("selected dashboard stays in navigation outside the loaded page; phone keeps three chips and All", async () => {
  for (const width of [1440, 390]) {
    const { tab } = await open({ width, paginated: true });
    try {
      await ready(tab);
      const sidebar = tab.locator(".pulse-workspace > .k2b-app-workspace__sidebar");
      const selected = sidebar.getByRole("link", { name: dashboardTestDashboard.name, exact: true });
      expect(await selected.isVisible()).toBe(true);
      expect(await selected.getAttribute("aria-current")).toBe("page");
      if (width === 390) {
        expect(await sidebar.getByRole("button", { name: "Weitere Dashboards", exact: true }).isVisible()).toBe(false);
        const visibleItems = await sidebar
          .locator(".k2b-app-workspace__sidebar-item")
          .evaluateAll((elements) => elements.filter((element) => element.getBoundingClientRect().height > 0).length);
        expect(visibleItems).toBe(3);
        const switcher = tab.locator(".pulse-workspace__mobile-header .k2b-sidebar-switcher__trigger");
        await switcher.click();
        const bases = tab.getByRole("dialog", { name: "Base wechseln", exact: true });
        expect(await bases.getByRole("link", { name: "Betrieb", exact: true }).getAttribute("href")).toBe("/app/pulse/Lad001");
        expect(await bases.getByRole("link", { name: "Deine Pulse-Basen", exact: true }).getAttribute("href")).toBe("/app/pulse");
        await tab.keyboard.press("Escape");
        await tab.getByRole("button", { name: "Alle Betrieb", exact: true }).click();
        const sheet = tab.locator(".k2b-app-workspace__sidebar-sheet");
        expect(await sheet.getByRole("button", { name: "Weitere Dashboards", exact: true }).isVisible()).toBe(true);
        expect(await sheet.getByRole("button", { name: "Quellen 4", exact: true }).isVisible()).toBe(true);
      }
    } finally {
      await tab.close();
    }
  }
}, 30_000);

test("cold polling respects future backoff across visibility changes and expired receipts use the public cadence", async () => {
  for (const receipt of ["2026-10-20T14:34:00.000Z", "2026-10-20T14:31:00.000Z"]) {
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { tab, panels, requests } = await open({ deferred });
    try {
      panels.set("req", {
        json: { panelId: "req", status: "waiting", error: null, lastGood: null, nextRefreshAt: receipt } satisfies DashboardPanelResult,
      });
      release();
      await tab.locator('[data-panel="hosts"][aria-busy="false"] .pulse-dashboard__table').waitFor();
      const count = () => requests.filter((request) => new URL(request.path).pathname.endsWith("/panels/req")).length;
      expect(count()).toBe(1);
      await tab.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, value: true });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await tab.clock.runFor(10000);
      await tab.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, value: false });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await tab.clock.runFor(49999);
      expect(count()).toBe(1);
      if (receipt.includes("14:34")) {
        const warm = tab.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/panels/hosts"));
        await tab.clock.runFor(1);
        await warm;
        await tab.locator('[data-panel="hosts"][aria-busy="false"] .pulse-dashboard__table').waitFor();
        expect(count()).toBe(1);
        panels.delete("req");
        await tab.clock.runFor(60000);
        await ready(tab);
      } else {
        panels.delete("req");
        await tab.clock.runFor(1);
        await ready(tab);
      }
      expect(count()).toBe(2);
    } finally {
      release();
      await tab.close();
    }
  }
}, 45_000);

test("metadata access recovery creates usable sharing actions again", async () => {
  const { tab, overviewReply, requests } = await open();
  try {
    await ready(tab);
    overviewReply({ status: 403, json: { code: "FORBIDDEN" } });
    await tab.clock.runFor(60000);
    await tab.getByText("Dashboard nicht verfügbar", { exact: true }).waitFor();
    overviewReply({ json: { ...baseOverviewFixture, attention: { items: [], total: 0, nextOffset: null } } });
    await tab.clock.runFor(60000);
    await ready(tab);
    await tab.getByRole("button", { name: "Teilen", exact: true }).click();
    await tab.locator("dialog[open]").waitFor();
    expect(requests.filter((request) => request.path.includes("/publish"))).toHaveLength(0);
    await tab.locator("dialog[open]").getByRole("button", { name: "Schließen", exact: true }).click();
  } finally {
    await tab.close();
  }
}, 30_000);

test("a dashboard-change 404 clears old values and reloads without claiming access was revoked", async () => {
  const { tab, panels } = await open();
  try {
    await ready(tab);
    panels.set("requests-now", { status: 404, json: { code: "NOT_FOUND", message: "Dashboard changed. Reload it to continue." } });
    await tab.clock.runFor(60000);
    await tab.getByText("Dashboard nicht verfügbar", { exact: true }).waitFor();
    expect(await tab.locator("[data-panel]").count()).toBe(0);
    expect(await tab.locator(".pulse-dashboard").textContent()).not.toContain("Du hast keinen Zugriff mehr");
    panels.delete("requests-now");
    await tab.locator(".pulse-dashboard").getByRole("button", { name: "Erneut versuchen", exact: true }).click();
    await ready(tab);
    expect(await tab.locator('[data-panel="req"] .k2b-chart').count()).toBe(1);
  } finally {
    await tab.close();
  }
}, 30_000);
