import { afterAll, beforeAll, expect, test } from "bun:test";
import { launchBrowser } from "../../../ui/test/browser";
import { buildWorkspaceHarness, origin, workspaceFixture } from "./PulseWorkspace.browser-fixture";
import { buildPulseWorkspaceHref, readWorkspacePathState } from "./workspace/routes";
import { sqlTestLimits, sqlTestQuery, sqlTestResult } from "./workspace/sql-test-fixtures";
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
const open = async (width: number, snapshot: Partial<PulseWorkspaceProps> = {}) => {
  const props: PulseWorkspaceProps = {
    ...workspaceFixture,
    initialRouteState: { view: "sql", sourceId: "", sql: "SELECT :host", params: { host: "web-01" } },
    initialSql: { limits: sqlTestLimits, query: null, error: null },
    ...snapshot,
  };
  const tab = await browser.newPage({ viewport: { width, height: 1000 } });
  await tab.clock.install({ time: new Date("2026-10-20T14:32:00Z") });
  await tab.clock.pauseAt(new Date("2026-10-20T14:32:00Z"));
  const runs: unknown[] = [];
  let response: { status: number; json: unknown } = { status: 200, json: sqlTestResult };
  await tab.route(`${origin}/api/**`, async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path.endsWith("/sql") && request.method() === "POST") {
      runs.push(request.postDataJSON());
      return route.fulfill(response);
    }
    if (path.endsWith("/queries")) return route.fulfill({ json: { items: [sqlTestQuery], total: 1, nextOffset: null } });
    if (path.endsWith("/sql/limits")) return route.fulfill({ json: sqlTestLimits });
    return route.fulfill({ status: 500, json: { code: "UNEXPECTED" } });
  });
  await tab.route(`${origin}/app/pulse/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: harness({ ...props, initialRouteState: readWorkspacePathState(route.request().url(), props.initialBaseId) }),
    }),
  );
  await tab.goto(`${origin}${buildPulseWorkspaceHref({ baseId: props.initialBaseId, state: props.initialRouteState })}`);
  await tab.getByRole("textbox", { name: "SQL", exact: true }).waitFor();
  return {
    tab,
    runs,
    answer: (value: typeof response) => {
      response = value;
    },
  };
};
const geometry = (tab: Awaited<ReturnType<typeof open>>["tab"]) =>
  tab.locator("[data-sql-region]").evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return [element.getAttribute("data-sql-region"), box.x, box.y, box.width, box.height];
    }),
  );
test("SQL states preserve editor, toolbar, limits, status and result geometry on phone and desktop", async () => {
  for (const width of [390, 1440]) {
    const { tab, runs, answer } = await open(width);
    try {
      const editor = tab.getByRole("textbox", { name: "SQL", exact: true });
      const before = await geometry(tab);
      await editor.fill("SELECT :missing");
      await tab.getByRole("button", { name: "Ausführen", exact: true }).click();
      await tab.getByText("Parameter fehlt · :missing ohne Wert · nichts gerechnet", { exact: true }).waitFor();
      expect(runs).toHaveLength(0);
      expect(await geometry(tab)).toEqual(before);
      await tab.getByRole("button", { name: "Wert eintragen" }).click();
      expect(await tab.getByRole("textbox", { name: ":missing" }).evaluate((element) => document.activeElement === element)).toBe(true);
      await tab.getByRole("textbox", { name: ":missing" }).fill("1");
      await tab.getByRole("button", { name: "Ausführen", exact: true }).click();
      await tab.getByRole("region", { name: "SQL-Ergebnis" }).waitFor();
      expect(runs).toHaveLength(1);
      expect(await geometry(tab)).toEqual(before);
      answer({ status: 429, json: { code: "QUOTA", resetAt: "2026-10-20T15:00:00Z" } });
      await editor.press("Control+Enter");
      await tab.getByText(/Stundenkontingent erreicht/).waitFor();
      expect(await tab.getByRole("button", { name: "Ausführen", exact: true }).isDisabled()).toBe(true);
      expect(await tab.getByRole("button", { name: "Speichern unter …" }).isEnabled()).toBe(true);
      await editor.press("Control+Enter");
      expect(runs).toHaveLength(2);
      expect(await geometry(tab)).toEqual(before);
      expect(await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    } finally {
      await tab.close();
    }
  }
}, 60_000);
test("saved selection loads only this base and edited SQL is reloadable without changing saved identity", async () => {
  const { tab } = await open(1440);
  try {
    await tab.getByRole("tab", { name: "Gespeichert", exact: true }).click();
    await tab.getByRole("button", { name: "CPU", exact: true }).click();
    await tab.getByRole("button", { name: "Abbrechen", exact: true }).last().click();
    await tab.getByRole("tab", { name: "Konsole", exact: true }).click();
    expect(await tab.getByRole("textbox", { name: "SQL", exact: true }).inputValue()).toBe("SELECT :host");
    await tab.getByRole("tab", { name: "Gespeichert", exact: true }).click();
    await tab.getByRole("button", { name: "CPU", exact: true }).click();
    await tab.getByRole("button", { name: "Verwerfen", exact: true }).click();
    await tab.getByRole("textbox", { name: "SQL", exact: true }).fill("SELECT 42");
    expect(new URL(tab.url()).pathname).toBe("/app/pulse/Lad001/sql/Qry001");
    expect(new URL(tab.url()).searchParams.get("sql")).toBe("SELECT 42");
  } finally {
    await tab.close();
  }
}, 30_000);

test("a reader's long SQL draft and values survive a reload without entering the URL", async () => {
  const { tab } = await open(390, { initialPermissions: { write: false, admin: false } });
  try {
    const sql = `SELECT '${"x".repeat(4113)}', :host`;
    await tab.getByRole("textbox", { name: "SQL", exact: true }).fill(sql);
    await tab.getByRole("textbox", { name: ":host" }).fill("db\\01");
    expect(new URL(tab.url()).searchParams.has("sql")).toBe(false);
    await tab.reload();
    await tab.waitForFunction((text) => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="SQL"]')?.value === text, sql);
    expect(await tab.getByRole("textbox", { name: ":host" }).inputValue()).toBe("db\\01");
    expect(await tab.getByRole("button", { name: "Speichern unter …" }).count()).toBe(0);
    await tab.getByText(/Dieser lange Entwurf bleibt/).waitFor();
  } finally {
    await tab.close();
  }
}, 30_000);

test("SQL diagnosis is visible and a duplicate save-as name can be replaced", async () => {
  const { tab, answer } = await open(1440);
  const names: string[] = [];
  try {
    answer({ status: 422, json: { code: "SQL_ERROR", message: "Unknown identifier missing_column", line: 1, column: 8 } });
    await tab.getByRole("textbox", { name: "SQL", exact: true }).fill("SELECT missing_column");
    await tab.getByRole("button", { name: "Ausführen", exact: true }).click();
    await tab.getByRole("status").filter({ hasText: "Unknown identifier missing_column" }).waitFor();
    await tab.route(`${origin}/api/pulse/bases/*/queries`, async (route) => {
      const input = route.request().postDataJSON();
      names.push(input.name);
      return route.fulfill(input.name === "Taken" ? { status: 409, json: { code: "CONFLICT" } } : { json: { ...sqlTestQuery, ...input } });
    });
    await tab.getByRole("button", { name: "Speichern unter …" }).click();
    await tab.getByRole("textbox", { name: "Name der Abfrage", exact: true }).fill("Taken");
    await tab.getByRole("textbox", { name: "Name der Abfrage", exact: true }).press("Enter");
    await tab.getByRole("button", { name: "Anderen Namen wählen" }).click();
    await tab.getByRole("textbox", { name: "Name der Abfrage", exact: true }).fill("Free");
    await tab.getByRole("textbox", { name: "Name der Abfrage", exact: true }).press("Enter");
    await tab.getByRole("heading", { name: "Free · Laden", exact: true }).waitFor();
    expect(names).toEqual(["Taken", "Free"]);
  } finally {
    await tab.close();
  }
}, 30_000);

test("opening settings preserves a SQL draft that only just fits the original URL", async () => {
  const { tab } = await open(1440);
  try {
    const sql = `SELECT '${"x".repeat(3960)}'`;
    await tab.getByRole("textbox", { name: "SQL", exact: true }).fill(sql);
    expect(new URL(tab.url()).searchParams.get("sql")).toBe(sql);
    await tab.getByRole("button", { name: "Einstellungen", exact: true }).click();
    expect(new URL(tab.url()).pathname.length + new URL(tab.url()).search.length).toBeLessThanOrEqual(4000);
    await tab.reload();
    await tab.waitForFunction((text) => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="SQL"]')?.value === text, sql);
  } finally {
    await tab.close();
  }
}, 30_000);

test("settings reload preserves parameter-only overrides and the saved SQL", async () => {
  const host = "%".repeat(1312) + "xx";
  const { tab } = await open(1440, {
    initialRouteState: { view: "sql", sourceId: "", queryId: "Qry001", params: { host } },
    initialSql: { limits: sqlTestLimits, query: sqlTestQuery, error: null },
  });
  try {
    await tab.getByRole("button", { name: "Einstellungen", exact: true }).click();
    expect(new URL(tab.url()).searchParams.has("params")).toBe(false);
    await tab.reload();
    await tab.waitForFunction((value) => [...document.querySelectorAll("input")].some((input) => input.value === value), host);
    expect(await tab.getByRole("textbox", { name: "SQL", exact: true }).inputValue()).toBe(sqlTestQuery.sql);
  } finally {
    await tab.close();
  }
}, 30_000);

test("editing SQL hides its old result and a response from an earlier draft", async () => {
  const { tab } = await open(1440);
  let reply: (() => void) | undefined;
  let requested: (() => void) | undefined;
  const requestSeen = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const endpoint = `${origin}/api/pulse/bases/*/sql`;
  await tab.route(endpoint, async (route) => {
    requested?.();
    await new Promise<void>((resolve) => {
      reply = resolve;
    });
    await route.fulfill({ json: sqlTestResult });
  });
  try {
    const editor = tab.getByRole("textbox", { name: "SQL", exact: true });
    await tab.getByRole("button", { name: "Ausführen", exact: true }).click();
    await tab.locator('[data-sql-region="toolbar"]').getByRole("button", { name: "Abbrechen", exact: true }).waitFor();
    await requestSeen;
    await editor.fill("SELECT 999 AS value");
    reply?.();
    await tab.getByRole("button", { name: "Ausführen", exact: true }).waitFor();
    expect(await tab.getByRole("region", { name: "SQL-Ergebnis" }).count()).toBe(0);
    await tab.unroute(endpoint);
    await tab.getByRole("button", { name: "Ausführen", exact: true }).click();
    await tab.getByRole("region", { name: "SQL-Ergebnis" }).waitFor();
    await editor.fill("SELECT :host");
    expect(await tab.getByRole("region", { name: "SQL-Ergebnis" }).count()).toBe(0);
  } finally {
    reply?.();
    await tab.close();
  }
}, 30_000);

test("SQL time axes remain readable on phone and desktop", async () => {
  for (const width of [390, 1440])
    for (const scenario of [
      { type: "DateTime('UTC')", last: "2026-10-20 11:00:00" },
      { type: "DateTime64(3, 'UTC')", last: "2026-10-20 11:48:00.002" },
    ]) {
      const { tab, answer } = await open(width);
      try {
        answer({
          status: 200,
          json: {
            ...sqlTestResult,
            columns: [
              { name: "time", type: scenario.type },
              { name: "orders", type: "UInt64" },
            ],
            rows: [
              ["2026-10-20 08:00:00", 1],
              ["2026-10-20 09:00:00", 2],
              ["2026-10-20 10:00:00", 3],
              [scenario.last, 4],
            ],
          },
        });
        await tab.getByRole("button", { name: "Ausführen", exact: true }).click();
        await tab.locator('[data-sql-region="result"] .stdlib-chart-axis-label').filter({ hasText: "20.10.2026" }).waitFor();
        const ticks = await tab
          .locator('[data-sql-region="result"] .stdlib-chart-tick-label[text-anchor="middle"]')
          .evaluateAll((elements) =>
            elements
              .map((element) => ({
                text: element.textContent ?? "",
                left: element.getBoundingClientRect().left,
                right: element.getBoundingClientRect().right,
              }))
              .filter((tick) => tick.text.length > 0)
              .sort((a, b) => a.left - b.left),
          );
        expect(ticks).toHaveLength(2);
        for (const [index, tick] of ticks.entries()) {
          expect(tick.text).toMatch(/\d{2}:\d{2}:\d{2}/);
          expect(tick.left).toBeGreaterThanOrEqual(0);
          expect(tick.right).toBeLessThanOrEqual(width);
          if (index) expect(tick.left).toBeGreaterThan(ticks[index - 1]!.right);
        }
      } finally {
        await tab.close();
      }
    }
}, 60_000);

test("SQL limits are visibly red and running keeps a result-size loading state", async () => {
  for (const width of [390, 1440]) {
    const { tab, answer } = await open(width);
    try {
      const before = await geometry(tab);
      for (const code of ["TIME_LIMIT", "MEMORY_LIMIT"]) {
        answer({ status: 422, json: { code } });
        await tab.getByRole("button", { name: "Ausführen", exact: true }).click();
        await tab
          .getByRole("status")
          .filter({ hasText: code === "TIME_LIMIT" ? "Zeitlimit erreicht" : "Speichergrenze erreicht" })
          .waitFor();
        const colors = await tab.locator('[data-sql-region="limits"]').evaluate((element) => {
          const probe = document.createElement("span");
          probe.style.color = "var(--k2b-danger-text)";
          element.append(probe);
          const expected = getComputedStyle(probe).color;
          probe.remove();
          return { actual: getComputedStyle(element).color, expected };
        });
        expect(colors.actual).toBe(colors.expected);
        expect(await geometry(tab)).toEqual(before);
      }
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await tab.route(`${origin}/api/pulse/bases/*/sql`, async (route) => {
        await gate;
        await route.fulfill({ json: sqlTestResult });
      });
      try {
        await tab.getByRole("button", { name: "Ausführen", exact: true }).click();
        await tab.locator('[data-sql-region="result"] [aria-busy="true"]').waitFor();
        expect(await geometry(tab)).toEqual(before);
        expect(await tab.locator('[data-sql-region="result"]').getByRole("button", { name: "Beispiel einsetzen" }).count()).toBe(0);
      } finally {
        release?.();
      }
    } finally {
      await tab.close();
    }
  }
}, 60_000);
