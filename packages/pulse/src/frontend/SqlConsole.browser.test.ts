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
const open = async (width: number, snapshot: Partial<PulseWorkspaceProps> = {}, locale = "de", dark = false) => {
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
      body: harness({ ...props, initialRouteState: readWorkspacePathState(route.request().url(), props.initialBaseId) }, locale, dark),
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
  tab.locator('[data-sql-region]:not([data-sql-region="result"])').evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return [element.getAttribute("data-sql-region"), box.x, box.y, box.width, box.height];
    }),
  );
test("SQL anchors remain stable while result height follows the original chart budget", async () => {
  for (const width of [390, 1440]) {
    const { tab, runs, answer } = await open(width);
    try {
      const editor = tab.getByRole("textbox", { name: "SQL", exact: true });
      const before = await geometry(tab);
      const resultHeight = () => tab.locator('[data-sql-region="result"]').evaluate((element) => element.getBoundingClientRect().height);
      expect(await resultHeight()).toBe(360);
      await editor.fill("SELECT :missing");
      await tab.getByRole("button", { name: "Ausführen", exact: true }).click();
      await tab
        .locator('[data-sql-region="result"] p[id]')
        .filter({
          hasText:
            "Für :missing fehlt ein Wert. Jeder Parameter im SQL braucht einen Wert. Trag ihn unten im Editor ein. Pulse prüft das vor dem Start.",
        })
        .waitFor();
      expect(runs).toHaveLength(0);
      expect(await geometry(tab)).toEqual(before);
      expect(await resultHeight()).toBe(360);
      await tab.getByRole("button", { name: "Wert eintragen" }).click();
      expect(await tab.getByRole("textbox", { name: ":missing" }).evaluate((element) => document.activeElement === element)).toBe(true);
      await tab.getByRole("textbox", { name: ":missing" }).fill("1");
      await tab.getByRole("button", { name: "Ausführen", exact: true }).click();
      await tab.getByRole("region", { name: "SQL-Ergebnis" }).waitFor();
      expect(runs).toHaveLength(1);
      expect(await geometry(tab)).toEqual(before);
      expect(await resultHeight()).toBe(360);
      answer({
        status: 200,
        json: {
          ...sqlTestResult,
          columns: [
            { name: "time", type: "DateTime('UTC')" },
            { name: "count", type: "UInt64" },
          ],
          rows: [
            ["2026-10-20 10:00:00", 1],
            ["2026-10-20 11:00:00", 2],
          ],
          rowCount: 2,
        },
      });
      await editor.press("Control+Enter");
      await tab.locator('[data-sql-region="result"] .k2b-chart').waitFor();
      expect(runs).toHaveLength(2);
      const chart = tab.locator('[data-sql-region="result"] .k2b-chart');
      expect((await chart.boundingBox())!.height).toBe(width === 390 ? 210 : 230);
      expect((await chart.locator(".k2b-chart__legend").boundingBox())!.height).toBe(30);
      expect((await chart.locator(".k2b-chart__svg").boundingBox())!.height).toBe(width === 390 ? 180 : 200);
      expect(await resultHeight()).toBe(width === 390 ? 560 : 600);
      expect(await geometry(tab)).toEqual(before);
      answer({ status: 429, json: { code: "QUOTA", resetAt: "2026-10-20T15:00:00Z" } });
      await editor.press("Control+Enter");
      await tab
        .locator('[data-sql-region="status"]')
        .filter({ hasText: /Stundenkontingent erreicht/ })
        .waitFor();
      expect(await tab.getByRole("button", { name: "Ausführen", exact: true }).isDisabled()).toBe(true);
      expect(await tab.getByRole("button", { name: "Speichern unter …" }).isEnabled()).toBe(true);
      await editor.press("Control+Enter");
      expect(runs).toHaveLength(3);
      await tab.getByRole("button", { name: "Ausführen", exact: true }).waitFor();
      expect(await geometry(tab)).toEqual(before);
      expect(await resultHeight()).toBe(360);
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
    const savedRow = tab.getByRole("button", { name: "CPU", exact: true });
    await savedRow.waitFor();
    expect(await savedRow.textContent()).toContain("SELECT :host");
    expect(await savedRow.textContent()).toContain("Geändert");
    expect(await savedRow.locator("time").getAttribute("datetime")).toBe(new Date(sqlTestQuery.updatedAt).toISOString());
    await savedRow.click();
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

test("saved rows expose real SQL and localized update labels at both widths", async () => {
  for (const [width, locale, savedLabel, updatedLabel] of [
    [390, "en", "Saved", "Updated"],
    [1440, "de", "Gespeichert", "Geändert"],
  ] as const) {
    const { tab } = await open(width, {}, locale);
    try {
      await tab.getByRole("tab", { name: savedLabel, exact: true }).click();
      const row = tab.getByRole("button", { name: "CPU", exact: true });
      await row.waitFor();
      expect(await row.textContent()).toContain("SELECT :host");
      expect(await row.locator(".truncate").evaluate((element) => getComputedStyle(element).fontFamily)).toContain("IBM Plex Mono");
      expect(await row.textContent()).toContain(updatedLabel);
      expect(await row.locator("time").getAttribute("datetime")).toBe(new Date(sqlTestQuery.updatedAt).toISOString());
      expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(64);
      await row.focus();
      expect(await row.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(await tab.locator("[role=columnheader]").count()).toBe(0);
      expect(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally {
      await tab.close();
    }
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

test("running keeps native controls read-only and settled edits hide the previous result", async () => {
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
    const parameter = tab.getByRole("textbox", { name: ":host", exact: true });
    for (const input of [editor, parameter]) {
      expect(await input.evaluate((element: HTMLInputElement | HTMLTextAreaElement) => element.readOnly)).toBe(true);
      const value = await input.inputValue();
      await input.focus();
      await input.press("x");
      expect(await input.inputValue()).toBe(value);
      await input.evaluate((element) => element.setAttribute("data-run-node", "same"));
    }
    expect(await tab.getByRole("button", { name: "Speichern unter …", exact: true }).isDisabled()).toBe(true);
    reply?.();
    await tab.getByRole("region", { name: "SQL-Ergebnis" }).waitFor();
    for (const input of [editor, parameter]) {
      expect(await input.evaluate((element: HTMLInputElement | HTMLTextAreaElement) => element.readOnly)).toBe(false);
      expect(await input.getAttribute("data-run-node")).toBe("same");
    }
    await tab.unroute(endpoint);
    await editor.fill("SELECT 999 AS value");
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

test("only the exceeded SQL limit is red and running preserves the fixed anchors", async () => {
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
          return {
            actual: Array.from(element.querySelectorAll<HTMLElement>("[data-sql-limit]")).map((part) => ({
              kind: part.dataset.sqlLimit,
              color: getComputedStyle(part).color,
            })),
            expected,
          };
        });
        const exceeded = code === "TIME_LIMIT" ? "time" : "memory";
        expect(colors.actual.filter((part) => part.color === colors.expected).map((part) => part.kind)).toEqual([exceeded]);
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
        await tab.locator('[data-sql-region="result"][aria-busy="true"]').waitFor();
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

test.each([
  [
    "de",
    "Profil normal: 2 GB, 10 s · 10.000 Zeilen oder 4 MiB · 12 von 600 Abfragen diese Stunde · Warteschlange 1 pro Base, 3 pro Cloud, 20 wartend, 5 s",
  ],
  [
    "en",
    "Profile normal: 2 GB, 10 s · 10,000 rows or 4 MiB · 12 of 600 queries this hour · Queue 1 per base, 3 per Cloud, 20 waiting, 5 s",
  ],
])(
  "SQL limits render the complete canonical wording in %s",
  async (locale, expected) => {
    const { tab } = await open(1440, {}, locale);
    try {
      expect(await tab.locator('[data-sql-region="limits"]').innerText()).toBe(expected);
    } finally {
      await tab.close();
    }
  },
  30_000,
);

test("the last of 32 parameters keeps its visible external diagnosis alongside save and Assistant recovery", async () => {
  const params = Object.fromEntries(Array.from({ length: 31 }, (_, index) => [`p${index}`, "1"]));
  const { tab, runs } = await open(390, {
    initialRouteState: { view: "sql", sourceId: "", sql: "SELECT 1", params },
  });
  try {
    await tab.route(`${origin}/api/pulse/bases/*/queries`, (route) => route.fulfill({ status: 500, json: { code: "REQUEST_FAILED" } }));
    await tab.getByRole("button", { name: "Speichern unter …", exact: true }).click();
    await tab.getByRole("textbox", { name: "Name der Abfrage", exact: true }).fill("Answer");
    await tab.getByRole("textbox", { name: "Name der Abfrage", exact: true }).press("Enter");
    const result = tab.locator('[data-sql-region="result"]');
    const saveDiagnosis = result.getByRole("heading", {
      name: "Die Abfrage ließ sich nicht speichern. Dein SQL bleibt erhalten.",
      exact: true,
    });
    await saveDiagnosis.waitFor();
    await tab.route(`${origin}/api/ai/conversations`, (route) => route.fulfill({ status: 500, json: { code: "REQUEST_FAILED" } }));
    await tab.getByRole("button", { name: "Mit KI fragen", exact: true }).click();
    const assistantDiagnosis = result.getByRole("heading", {
      name: "Der Assistant ließ sich nicht öffnen",
      exact: true,
    });
    await assistantDiagnosis.waitFor();
    const editor = tab.getByRole("textbox", { name: "SQL", exact: true });
    await editor.fill(`SELECT ${Array.from({ length: 32 }, (_, index) => `:p${index}`).join(", ")}`);
    const last = tab.getByRole("textbox", { name: ":p31", exact: true });
    await last.evaluate((element) => element.setAttribute("data-original-parameter", "true"));
    await editor.evaluate((element) => element.setAttribute("data-original-editor", "true"));
    const run = tab.getByRole("button", { name: "Ausführen", exact: true });
    await run.click();
    const diagnosis = result.locator("p[id]");
    await diagnosis
      .filter({
        hasText:
          "Für :p31 fehlt ein Wert. Jeder Parameter im SQL braucht einen Wert. Trag ihn unten im Editor ein. Pulse prüft das vor dem Start.",
      })
      .waitFor();
    expect(runs).toHaveLength(0);
    expect(await run.evaluate((element) => document.activeElement === element)).toBe(true);
    expect(await tab.locator('[data-sql-region="editor"] input').count()).toBe(32);
    expect(await tab.locator('[data-sql-region="editor"] input[aria-invalid="true"]').count()).toBe(1);
    expect(await last.getAttribute("aria-describedby")).toBe(await diagnosis.getAttribute("id"));
    expect(await diagnosis.isVisible()).toBe(true);
    expect(await tab.locator('[data-sql-region="editor"] .k2b-field__error').count()).toBe(0);
    expect(await result.locator('[role="alert"], [aria-live]').count()).toBe(0);
    const status = tab.locator('[data-sql-region="status"] [role="status"]');
    expect(await status.count()).toBe(1);
    expect(await status.innerText()).toContain("Parameter fehlt · :p31 ohne Wert · nichts gerechnet");
    expect(await saveDiagnosis.isVisible()).toBe(true);
    expect(await assistantDiagnosis.isVisible()).toBe(true);
    expect(await saveDiagnosis.locator("..").getByRole("button", { name: "Erneut versuchen", exact: true }).isEnabled()).toBe(true);
    expect(await tab.locator('[data-sql-region="status"]').getByRole("button", { name: "Erneut versuchen", exact: true }).isEnabled()).toBe(
      true,
    );
    const visibleInStrip = () =>
      last.evaluate((element) => {
        const strip = element.closest("[data-sql-parameter-strip]")!;
        const input = element.getBoundingClientRect(),
          bounds = strip.getBoundingClientRect();
        return input.left >= bounds.left - 1 && input.right <= bounds.right + 1;
      });
    expect(await visibleInStrip()).toBe(true);
    await result.getByRole("button", { name: "Wert eintragen", exact: true }).click();
    expect(await last.evaluate((element) => document.activeElement === element)).toBe(true);
    await tab.waitForFunction(() => {
      const input = document.querySelector<HTMLInputElement>('input[aria-label=":p31"]');
      const strip = input?.closest("[data-sql-parameter-strip]");
      if (!input || !strip || document.activeElement !== input) return false;
      const box = input.getBoundingClientRect(),
        bounds = strip.getBoundingClientRect();
      return box.left >= bounds.left - 1 && box.right <= bounds.right + 1;
    });
    expect(await visibleInStrip()).toBe(true);
    await last.fill("2");
    expect(await last.getAttribute("data-original-parameter")).toBe("true");
    expect(await editor.getAttribute("data-original-editor")).toBe("true");
    expect(await last.getAttribute("aria-invalid")).toBeNull();
    expect(await last.getAttribute("aria-describedby")).toBeNull();
    expect(await diagnosis.isVisible()).toBe(false);
    expect(await saveDiagnosis.isVisible()).toBe(true);
    expect(await assistantDiagnosis.isVisible()).toBe(true);
  } finally {
    await tab.close();
  }
}, 30_000);

test("parameter Enter and editor shortcut share the stable Run and Cancel action", async () => {
  const { tab } = await open(390);
  let release: (() => void) | undefined;
  let cancels = 0;
  await tab.route(`${origin}/api/pulse/bases/*/sql`, async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ json: sqlTestResult }).catch(() => {});
  });
  await tab.route(`${origin}/api/pulse/bases/*/sql/cancel`, (route) => {
    cancels++;
    return route.fulfill({ json: { cancelled: true } });
  });
  try {
    const editor = tab.getByRole("textbox", { name: "SQL", exact: true });
    const parameter = tab.getByRole("textbox", { name: ":host", exact: true });
    const action = tab.locator('[data-sql-region="toolbar"] button').first();
    const size = await action.boundingBox();
    const anchors = await geometry(tab);
    for (const input of [editor, parameter]) await input.evaluate((e) => e.setAttribute("data-original-node", "true"));
    await parameter.press("Enter");
    await tab.locator('[data-sql-region="result"][aria-busy="true"]').waitFor();
    expect(await action.boundingBox()).toEqual(size);
    expect(await geometry(tab)).toEqual(anchors);
    expect(await parameter.evaluate((e: HTMLInputElement) => e.readOnly)).toBe(true);
    await editor.press("Control+Enter");
    await tab.waitForFunction(() => !document.querySelector('[data-sql-region="result"][aria-busy="true"]'));
    expect(cancels).toBe(1);
    expect(await action.boundingBox()).toEqual(size);
    expect(await geometry(tab)).toEqual(anchors);
    expect(await parameter.inputValue()).toBe("web-01");
    expect(await editor.inputValue()).toBe("SELECT :host");
    for (const input of [editor, parameter]) expect(await input.getAttribute("data-original-node")).toBe("true");
  } finally {
    release?.();
    await tab.close();
  }
}, 30_000);

test("SQL composition keeps phone orientation, local syntax colors and monospace values in both themes", async () => {
  for (const dark of [false, true]) {
    const { tab } = await open(390, { initialRouteState: { view: "sql", sourceId: "", sql: "" } }, "de", dark);
    try {
      const head = tab.locator('[data-sql-region="editor-head"]');
      expect(await head.getByText("Tabellen:", { exact: false }).isVisible()).toBe(true);
      expect((await head.boundingBox())!.height).toBe(36);
      expect(await tab.locator("html").getAttribute("class")).toContain(dark ? "dark" : "light");
      const surface = await tab.locator('[data-sql-region="editor"]').evaluate((element) => getComputedStyle(element).backgroundColor);
      expect(surface).not.toBe("rgba(0, 0, 0, 0)");
      await tab.getByRole("button", { name: "Beispiel einsetzen" }).click();
      expect(await head.getByText("Beispiel-SQL", { exact: true }).isVisible()).toBe(true);
      expect(await head.getByText("Tabellen:", { exact: false }).isVisible()).toBe(false);
      await tab.getByRole("textbox", { name: "SQL", exact: true }).fill("SELECT :host, 'text', 1");
      // The overlay paints on requestAnimationFrame; advance the frozen fixture clock.
      await tab.clock.runFor(32);
      expect(await head.getByText("Beispiel-SQL", { exact: true }).count()).toBe(0);
      expect(await head.getByText("Tabellen:", { exact: false }).isVisible()).toBe(true);
      await tab.waitForFunction(() =>
        [".cd-k", ".cd-param", ".cd-s", ".cd-n"].every((selector) => document.querySelector(`[data-sql-region="editor"] ${selector}`)),
      );
      const colors = await tab.locator('[data-sql-region="editor"]').evaluate((element) => {
        const selectors = [".cd-k", ".cd-param", ".cd-s", ".cd-n"];
        const result = selectors.map((selector) => getComputedStyle(element.querySelector(selector)!).color);
        const reference = document.createElement("span");
        element.append(reference);
        const expected = (
          element.ownerDocument.documentElement.classList.contains("dark")
            ? ["#a5b8f3", "#c4b5fd", "#6ee7b7", "#fcd34d"]
            : ["#1e40af", "#7c3aed", "#047857", "#b45309"]
        ).map((color) => {
          reference.style.color = color;
          return getComputedStyle(reference).color;
        });
        reference.remove();
        return { result, expected };
      });
      expect(colors.result).toEqual(colors.expected);
      await tab.getByRole("textbox", { name: ":host", exact: true }).fill("web-01");
      await tab.waitForFunction(() => document.fonts.status === "loaded");
      expect(
        await tab.locator("[data-sql-parameter-strip] .font-semibold").evaluate((element) => getComputedStyle(element).fontFamily),
      ).toContain("IBM Plex Mono");
      await tab.getByRole("button", { name: "Ausführen", exact: true }).click();
      await tab.getByRole("region", { name: "SQL-Ergebnis", exact: true }).waitFor();
      expect(
        await tab
          .locator("tbody td")
          .first()
          .locator("div")
          .first()
          .evaluate((element) => getComputedStyle(element).fontFamily),
      ).toContain("IBM Plex Mono");
      // Removing only the local palette restores the package defaults, including parameter→number fallback.
      const defaults = await tab.locator('[data-sql-region="editor"]').evaluate((element) => {
        element.removeAttribute("style");
        return [".cd-param", ".cd-n"].map((selector) => getComputedStyle(element.querySelector(selector)!).color);
      });
      expect(defaults[0]).toBe(defaults[1]);
    } finally {
      await tab.close();
    }
  }
}, 30_000);

test("failed runs show short status, visible recovery help and the correct retry on phone and desktop", async () => {
  for (const width of [390, 1440]) {
    const { tab, answer, runs } = await open(width);
    try {
      for (const [code, title, help] of [
        ["TIME_LIMIT", "Zeitlimit erreicht", "Ein kürzerer Zeitraum"],
        ["MEMORY_LIMIT", "Speichergrenze erreicht", "Weniger Spalten"],
        ["BUSY", "Pulse ist ausgelastet", "nicht gestartet"],
        ["QUEUE_FULL", "Pulse ist ausgelastet", "nicht eingereiht"],
        ["STORE_UNAVAILABLE", "Pulse erreicht den Datenspeicher nicht", "Dein SQL bleibt hier stehen"],
        ["NO_READ_ACCESS", "Kein Lesezugriff", "SQL braucht"],
      ]) {
        answer({ status: 422, json: { code } });
        await tab.getByRole("button", { name: "Ausführen", exact: true }).click();
        const result = tab.locator('[data-sql-region="result"]');
        await result.locator("p").filter({ hasText: help }).waitFor();
        expect(await tab.locator('[data-sql-region="status"] strong').innerText()).toBe(title!);
        expect(await result.getByRole("heading").innerText()).toBe(title!);
        expect(await tab.locator('[data-sql-region="status"]').getByRole("button", { name: "Erneut versuchen", exact: true }).count()).toBe(
          code === "NO_READ_ACCESS" ? 0 : 1,
        );
        expect(await tab.getByRole("textbox", { name: "SQL", exact: true }).inputValue()).toBe("SELECT :host");
        if (code !== "NO_READ_ACCESS") {
          const before = runs.length;
          answer({ status: 200, json: sqlTestResult });
          await tab.locator('[data-sql-region="status"]').getByRole("button", { name: "Erneut versuchen", exact: true }).click();
          await tab.getByRole("region", { name: "SQL-Ergebnis", exact: true }).waitFor();
          expect(runs.length).toBe(before + 1);
        }
      }
    } finally {
      await tab.close();
    }
  }
}, 60_000);

test("elapsed request time stays outside the single live status and disappears on cancel", async () => {
  const { tab } = await open(390);
  let release: (() => void) | undefined;
  try {
    await tab.route(`${origin}/api/pulse/bases/*/sql`, async (route) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.fulfill({ json: sqlTestResult }).catch(() => {});
    });
    await tab.route(`${origin}/api/pulse/bases/*/sql/cancel`, (route) => route.fulfill({ json: { cancelled: true } }));
    await tab.getByRole("button", { name: "Ausführen", exact: true }).click();
    await tab.getByRole("timer").waitFor();
    await tab.clock.runFor(2100);
    expect(await tab.getByRole("timer").innerText()).toContain("Anfrage läuft seit 2 s");
    expect(
      await tab.getByRole("timer").evaluate((element) => element.parentElement?.closest('[role="status"], [aria-live="polite"]') === null),
    ).toBe(true);
    const status = tab.locator('[data-sql-region="status"] [role="status"]');
    expect(await status.count()).toBe(1);
    expect(await status.innerText()).toBe("Läuft");
    await tab.getByRole("button", { name: "Abbrechen", exact: true }).click();
    await tab.getByRole("timer").waitFor({ state: "detached" });
    release?.();
  } finally {
    release?.();
    await tab.close();
  }
}, 30_000);
