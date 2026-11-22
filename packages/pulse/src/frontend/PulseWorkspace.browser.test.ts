import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { launchBrowser } from "../../../ui/test/browser";
import { buildWorkspaceHarness, origin, pauseWorkspaceClock, workspaceFixture } from "./PulseWorkspace.browser-fixture";
import { buildPulseWorkspaceHref } from "./workspace/routes";
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
  await pauseWorkspaceClock(tab.clock, new Date("2026-10-19T12:40:00.000Z"));
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

describe("Pulse base workspace", () => {
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

  test("the third source path opens the exact unsent Assistant draft", async () => {
    const { tab } = await open(views[1]!, workspaceFixture);
    tab.setDefaultTimeout(5_000);
    const requests: unknown[] = [];
    await tab.route(`${origin}/api/ai/**`, (route) => {
      const request = route.request();
      requests.push({ path: new URL(request.url()).pathname, method: request.method(), body: request.postDataJSON() });
      return route.fulfill({ status: 201, json: { id: "Cht001", draft: { content: [], revision: 1, updatedAt: null } } });
    });
    await tab.route(`${origin}/app/assistant**`, (route) => route.fulfill({ contentType: "text/html", body: "<p>Assistant fixture</p>" }));
    try {
      await tab.getByRole("button", { name: "Quelle anlegen", exact: true }).click();
      const dialog = tab.locator("dialog[open]");
      await dialog.getByRole("heading", { name: "Neue Quelle in Laden" }).waitFor();
      await dialog.getByRole("button", { name: /Mit KI fragen/ }).click();
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
                {
                  type: "text",
                  text: "Hilf mir, eine Quelle an die Pulse-Basis „Laden“ anzubinden. Schlag die Quelle und ein Skript vor und frag, bevor du etwas anlegst.",
                },
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
      await tab.getByRole("button", { name: "Quelle anlegen", exact: true }).click();
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
      await tab.getByRole("button", { name: "CPU", exact: true }).waitFor();
      // Opening the list again reads it again; this read is refused.
      await tab.getByRole("tab", { name: "Konsole", exact: true }).click();
      await tab.getByRole("tab", { name: "Gespeichert", exact: true }).click();
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
});

describe("Pulse base page after the cut", () => {
  // The old ways: /:base/dashboards and /:base/dashboards/:id redirect here with ?notice=dashboards-removed, /:base/overview
  // without it (redirects: removed-routes.render.test.tsx). The page says what happened once and keeps the base usable.
  test("an old dashboard link opens the base with a notice that names no dashboard and goes away on request", async () => {
    for (const view of views) {
      const props: PulseWorkspaceProps = { ...workspaceFixture, initialNotice: "dashboards-removed" };
      const { tab, calls } = await open(view, props);
      try {
        await tab.goto(`${origin}/app/pulse/${props.initialBaseId}?notice=dashboards-removed`);
        await tab.getByText("Dashboards gibt es nicht mehr").waitFor();
        expect(await tab.getByText("Newsletter-Skript").first().isVisible()).toBe(true);
        expect(await overflow(tab)).toBeLessThanOrEqual(0);
        // The notice cell stands at the top of Sources and leads to Usage, where the pages that read the base are.
        expect(await tab.locator(".pulse-tab > :first-child .k2b-notice-card").getByText("Dashboards gibt es nicht mehr").count()).toBe(1);
        expect(await tab.getByRole("link", { name: "Nutzung öffnen" }).getAttribute("href")).toBe(
          `/app/pulse/${props.initialBaseId}/usage`,
        );
        await tab.getByRole("button", { name: "Verstanden" }).click();
        await tab.getByText("Dashboards gibt es nicht mehr").waitFor({ state: "hidden" });
        expect(new URL(tab.url()).searchParams.has("notice")).toBe(false);
        expect(calls).toEqual([]);
      } finally {
        await tab.close();
      }
    }
  }, 60_000);

  test("an old overview link opens the base without a notice, and no menu leads to an overview or dashboards", async () => {
    const { tab } = await open(views[1]!, workspaceFixture);
    try {
      await tab.getByText("Newsletter-Skript").first().waitFor();
      expect(await tab.getByText("Dashboards gibt es nicht mehr").count()).toBe(0);
      await tab.getByRole("button", { name: "Mehr zu dieser Basis" }).click();
      await tab.getByRole("menuitem", { name: "Einstellungen der Basis" }).waitFor();
      for (const name of ["Übersicht", "Dashboards"]) expect(await tab.getByRole("menuitem", { name }).count()).toBe(0);
    } finally {
      await tab.close();
    }
  }, 30_000);

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

  test("an open sources view refreshes the status every 5 seconds and keeps every row in place", async () => {
    // First refresh: newer arrivals, the same problems. Second refresh: the throttled source recovers.
    const newer = workspaceFixture.initialSources.map((source) => ({
      ...source,
      lastSeenAt: "2026-10-19T12:39:58.000Z",
      status: { ...source.status, newestDataAt: "2026-10-19T12:39:58.000Z" },
    }));
    const recovered = newer.map((source) =>
      source.id === "Src004" ? { ...source, status: { ...source.status, throttled: false, throttledAt: null } } : source,
    );
    let answer = newer;
    const { tab, calls } = await open(views[1]!, workspaceFixture, "de", (url) =>
      new URL(url).pathname === "/api/pulse/bases/Lad001/sources" ? { status: 200, json: answer } : { status: 500, json: {} },
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
      const top = (selector: string) =>
        tab.evaluate(
          (selector) =>
            [...document.querySelectorAll(selector)]
              .filter((element) => element.checkVisibility())
              .map((element) => element.getBoundingClientRect().top),
          selector,
        );
      const sourceRows = () => top(".pulse-sources tbody tr");
      const attentionRows = () => top(".pulse-attention tbody tr");
      const statusRow = () => top(".k2b-status-row");
      const before = { sources: await sourceRows(), attention: await attentionRows(), status: await statusRow() };
      expect(before.sources).toHaveLength(4);
      expect(before.attention).toHaveLength(1);
      await tab.clock.runFor(4_900);
      expect(calls).toEqual([]);
      await tab.clock.runFor(200);
      // The response arrives over the real network; the locator waits from the test side, whose timers are not frozen.
      await tab.getByText("vor 2 s", { exact: true }).first().waitFor();
      expect(calls).toEqual(["/api/pulse/bases/Lad001/sources"]);
      // New values with the same problems: not a row moves.
      expect({ sources: await sourceRows(), attention: await attentionRows(), status: await statusRow() }).toEqual(before);
      answer = recovered;
      await tab.clock.runFor(5_000);
      await tab
        .locator(".k2b-status-badge__label")
        .filter({ hasText: /^Gedrosselt$/, visible: true })
        .waitFor({ state: "hidden" });
      expect(await throttled()).toBe(0);
      expect(calls).toEqual(["/api/pulse/bases/Lad001/sources", "/api/pulse/bases/Lad001/sources"]);
      // The recovered source leaves "Needs attention" (concept: the list shows only what needs attention). The status
      // row keeps its place, and the sources keep their order and spacing: they move up together by the list's height.
      expect(await attentionRows()).toEqual([]);
      expect(await statusRow()).toEqual(before.status);
      const after = await sourceRows();
      const shift = before.sources[0]! - after[0]!;
      expect(shift).toBeGreaterThan(0);
      expect(after.map((value) => value + shift)).toEqual(before.sources);
    } finally {
      await tab.close();
    }
  }, 60_000);

  test("a 5-second refresh keeps the sources tab, its scroll position and the focused row", async () => {
    // Enough sources that Main scrolls at 1440 px; the refresh brings new values for the same rows.
    const template = workspaceFixture.initialSources[0]!;
    const many = [
      ...workspaceFixture.initialSources,
      ...Array.from({ length: 32 }, (_, index) => ({
        ...template,
        id: `Src${String(index + 100)}`,
        name: `Kasse ${String(index + 1).padStart(2, "0")}`,
      })),
    ];
    const newer = many.map((source, index) => ({
      ...source,
      todayCount: 1000 + index,
      lastSeenAt: "2026-10-19T12:39:58.000Z",
      status: { ...source.status, newestDataAt: "2026-10-19T12:39:58.000Z" },
    }));
    const { tab, calls } = await open(views[1]!, { ...workspaceFixture, initialSources: many }, "de", (url) =>
      new URL(url).pathname === "/api/pulse/bases/Lad001/sources" ? { status: 200, json: newer } : { status: 500, json: {} },
    );
    try {
      await tab.getByText("Kasse 32", { exact: true }).waitFor({ state: "attached" });
      const before = await tab.evaluate(() => {
        const main = document.querySelector<HTMLElement>(".k2b-app-workspace__main")!;
        main.scrollTop = 300;
        const rows = [...document.querySelectorAll<HTMLElement>(".pulse-sources tbody tr.k2b-data-table__row")];
        const top = main.getBoundingClientRect().top;
        // A row in view after the scroll, so focusing it does not move Main.
        const row = rows.find((element) => element.getBoundingClientRect().top > top + 100)!;
        row.focus({ preventScroll: true });
        const marks = window as unknown as { pulseTab?: Element | null; pulseRow?: Element };
        marks.pulseTab = document.querySelector("section.pulse-tab");
        marks.pulseRow = row;
        return {
          rows: rows.length,
          overflow: main.scrollHeight - main.clientHeight,
          scrollTop: main.scrollTop,
          focused: document.activeElement === row,
        };
      });
      expect(before.rows).toBe(many.length);
      expect(before.overflow).toBeGreaterThan(300);
      expect(before.scrollTop).toBe(300);
      expect(before.focused).toBe(true);
      await tab.clock.runFor(5_100);
      await tab.locator(".pulse-sources tbody tr.k2b-data-table__row").getByText("1.035", { exact: true }).waitFor({ state: "attached" });
      expect(calls).toEqual(["/api/pulse/bases/Lad001/sources"]);
      const after = await tab.evaluate(() => {
        const main = document.querySelector<HTMLElement>(".k2b-app-workspace__main")!;
        const marks = window as unknown as { pulseTab?: Element | null; pulseRow?: Element };
        return {
          scrollTop: main.scrollTop,
          sameRow: document.activeElement === marks.pulseRow,
          rowConnected: marks.pulseRow?.isConnected ?? false,
          sameTab: document.querySelector("section.pulse-tab") === marks.pulseTab,
        };
      });
      expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(1);
      expect(after).toMatchObject({ sameRow: true, rowConnected: true, sameTab: true });
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
      {
        ...workspaceFixture,
        initialBases: [clearing],
        // The SQL view has no periodic source refresh, so only the settings poll reads the base list.
        initialRouteState: { view: "sql", sourceId: "", sql: "" },
        initialSql: { limits: sqlTestLimits, query: null, error: null },
      },
      "de",
      (url) => {
        const path = new URL(url).pathname;
        if (path === "/api/pulse/bases") return { status: 200, json: [failed] };
        if (path.endsWith("/sql/limits")) return { status: 200, json: sqlTestLimits };
        return { status: 500, json: {} };
      },
    );
    try {
      await tab.getByRole("button", { name: "Mehr zu dieser Basis" }).click();
      await tab.getByRole("menuitem", { name: "Einstellungen der Basis" }).click();
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
    await pauseWorkspaceClock(tab.clock, new Date("2026-10-19T12:40:00.000Z"));
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
  const confirmation = tab.getByRole("dialog", { name: "Ungespeicherte Änderungen", exact: true });
  const confirmDiscard = confirmation.getByRole("button", { name: "Verwerfen", exact: true });
  try {
    await tab.getByRole("button", { name: "Mehr zu dieser Basis" }).click();
    await tab.getByRole("menuitem", { name: "Einstellungen der Basis" }).click();
    const name = tab.getByRole("textbox", { name: "Name", exact: true });
    await name.fill("Laden Entwurf");
    await tab.evaluate(() => window.history.back());
    await confirmation.getByText("Ungespeicherte Änderungen verwerfen?", { exact: true }).waitFor();
    await confirmation.getByRole("button", { name: "Abbrechen", exact: true }).click();
    await confirmation.waitFor({ state: "hidden" });
    expect(await name.inputValue()).toBe("Laden Entwurf");
    expect(new URL(tab.url()).searchParams.get("settings")).toBe("general");
    await name.press("Escape");
    await confirmation.getByText("Ungespeicherte Änderungen verwerfen?", { exact: true }).waitFor();
    await confirmation.getByRole("button", { name: "Abbrechen", exact: true }).click();
    await confirmation.waitFor({ state: "hidden" });
    expect(await name.inputValue()).toBe("Laden Entwurf");
    // The form also has a visible "Verwerfen" button. Back opens its confirmation asynchronously;
    // selecting by button name alone can retain the form button just as the prompt hides it.
    expect(await tab.getByRole("button", { name: "Verwerfen", exact: true }).isVisible()).toBe(true);
    expect(await confirmDiscard.count()).toBe(0);
    await tab.evaluate(() => window.history.back());
    await confirmDiscard.click();
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
        const name = field.querySelector(".k2b-settings-field__copy")!.getBoundingClientRect();
        const control = field.querySelector(".k2b-settings-field__control")!.getBoundingClientRect();
        return {
          padding: getComputedStyle(field).paddingLeft,
          wide: field.getBoundingClientRect().width >= 640,
          besideName: control.left >= name.right,
        };
      });
      expect(fieldGeometry.padding).toBe("0px");
      // The shared settings row puts name and control side by side wherever the field has room.
      expect(fieldGeometry.besideName).toBe(fieldGeometry.wide);
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
      // Three flat figures: the limit stands quietly at the figure, the share used on the third line.
      const figures = dialog.locator('.k2b-stat-grid[data-variant="plain"] .k2b-stat-cell');
      await figures.first().waitFor();
      expect(await figures.count()).toBe(3);
      expect(
        await figures
          .first()
          .getByText(/^36\s%\sgenutzt · gemessen /)
          .isVisible(),
      ).toBe(true);
      expect(await dialog.getByText("Obergrenze, die Rate wird nicht gemessen", { exact: true }).isVisible()).toBe(true);
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
      // The queries figure keeps its place and says it did not load; the stored usage stays a known fact.
      expect(await dialog.locator('.k2b-stat-cell[data-status="error"]').getByText("Nicht geladen", { exact: true }).isVisible()).toBe(
        true,
      );
      expect(await dialog.getByText("Noch nicht gemessen", { exact: true }).count()).toBe(0);
      fail = false;
      await dialog.getByRole("alert").getByRole("button").click();
      await dialog.getByText("16 KiB · 32 × 2 KiB", { exact: true }).waitFor();
      expect(await dialog.locator('.k2b-stat-cell[data-status="error"]').count()).toBe(0);
      expect(await dialog.locator(".k2b-skeleton").count()).toBe(0);
      await dialog.getByRole("tab", { name: "Leeren und löschen", exact: true }).click();
      expect(await dialog.locator('button[data-variant="danger"]').count()).toBe(0);
    } finally {
      release?.();
      await tab.close();
    }
  }
}, 60_000);
