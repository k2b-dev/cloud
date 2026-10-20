import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { launchBrowser } from "../../../ui/test/browser";
import { buildWorkspaceHarness, origin, workspaceFixture } from "./PulseWorkspace.browser-fixture";
import { sqlTestLimits } from "./workspace/sql-test-fixtures";
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
  await tab.goto(
    `${origin}/app/pulse/Lad001${props.initialRouteState.view === "coming-back" ? "/dashboards" : "/sources"}${props.initialRouteState.settings ? `?settings=${props.initialRouteState.settings}` : ""}`,
  );
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
    await tab.route(`${origin}/api/**`, (route) => {
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
