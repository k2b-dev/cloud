import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// The geometry of the timeline (rail, grid, type) and the clicks of a row need a real engine.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "activity-list.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { ActivityCard, ActivityList, LocaleProvider } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
window.opened = 0;
window.acted = 0;
const draft = (minute) => ({
  at: "2026-10-27T10:" + minute + ":00+01:00", icon: "ti ti-pencil", text: "Entwurf geändert", actor: "Elif Kaya", kind: "change",
  bundle: { key: "draft", text: (count) => "Entwurf " + count + "-mal geändert" },
});
const link = (label) => { const a = document.createElement("a"); a.href = "#doc"; a.textContent = label; return a; };
const entries = () => [
  { at: "2026-11-12T08:31:00+01:00", icon: "ti ti-mail-x", tone: "danger", text: "Einladung unzustellbar", detail: "team@stadtpark.example · Postfach voll",
    action: { icon: "ti ti-send", label: "Einladung erneut senden", data: "resend", onClick: () => { window.acted++; } }, kind: "mail" },
  { at: "2026-11-12T08:30:00+01:00", icon: "ti ti-bell-ringing", tone: "warning", text: "Erinnerung gesendet", detail: ["Neue Frist 20.11. · ", link("Schreiben")], actor: "Mira Lang", kind: "mail" },
  { at: "2026-11-10T14:05:00+01:00", icon: "ti ti-circle-check", tone: "success", text: "Freigegeben", actor: "Jonas Weber", kind: "change",
    detail: createComponent(ActivityList.Change, { term: "Stand", before: "In Prüfung", now: "Freigegeben" }) },
  { at: "2026-10-28T08:14:00+01:00", icon: "ti ti-eye", text: "Über den Link geöffnet", actor: "Gast", onOpen: () => { window.opened++; } },
  { at: "2026-10-27T11:02:00+01:00", icon: "ti ti-mail", text: "Per E-Mail gesendet", actor: "Mira Lang", kind: "mail",
    details: () => "An team@stadtpark.example · Betreff „Einladung zum Sommerfest“" },
  { at: "2026-10-27T10:38:00+01:00", icon: "ti ti-lock-open", text: "Für das Team freigegeben", actor: "Mira Lang" },
  { at: "2026-10-27T10:36:00+01:00", icon: "ti ti-paperclip", text: ["Datei ", link("Ablaufplan.pdf"), " hinzugefügt"], actor: "Elif Kaya", kind: "file" },
  draft("35"), draft("30"), draft("24"), draft("20"),
  { at: "2026-10-27T10:12:00+01:00", icon: "ti ti-table-import", text: "38 Aufgaben aus Datei übernommen", actor: "Elif Kaya", kind: "file" },
  { at: "2026-10-27T10:05:00+01:00", icon: "ti ti-plus", text: ["Aus Vorlage ", link("Veranstaltung"), " erstellt"], actor: "Tom Reiter", kind: "change" },
];
render(() => createComponent(LocaleProvider, { locale: "de", get children() {
  return createComponent(ActivityCard, {
    get entries() { return entries(); },
    now: "2026-11-12T15:31:00Z", timeZone: "Europe/Berlin", subtitle: "Projekt Sommerfest",
    kinds: [{ key: "mail", label: "E-Mails" }, { key: "change", label: "Änderungen" }, { key: "file", label: "Dateien" }],
  });
} }), document.getElementById("root"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the activity list fixture.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (width = 720) => {
  // Not about motion: without reduced motion, the button colour fading back after the dialog keeps settled() busy.
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  // Only Date stands at the mockup's "now", so the browser's own reading of the clock changes nothing; timers stay real.
  await context.addInitScript((now: number) => {
    const Real = Date;
    window.Date = new Proxy(Real, {
      construct: (target, args) => new target(...((args.length > 0 ? args : [now]) as [number])),
      get: (target, key) => (key === "now" ? () => now : Reflect.get(target, key)),
    });
  }, Date.parse("2026-11-12T15:31:00Z"));
  const page = await context.newPage();
  await page.setContent(
    `<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:24px}</style></head><body class="k2b-ui" data-theme="light"><div id="root"></div></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.waitForSelector(".k2b-activity__entry");
  await settled(page);
  return page;
};
const counters = (page: Page) =>
  page.evaluate(() => ({ opened: (window as never as { opened: number }).opened, acted: (window as never as { acted: number }).acted }));

describe("ActivityList", () => {
  test("draws the rail, grid and type of the Warenfluss timeline", async () => {
    const page = await load();
    try {
      const geometry = await page.evaluate(() => {
        const list = document.querySelector(".k2b-activity")!.getBoundingClientRect();
        const row = document.querySelectorAll<HTMLElement>(".k2b-activity__entry")[1]!;
        const rail = getComputedStyle(row, "::before");
        const below = getComputedStyle(row, "::after");
        const iconElement = row.querySelector(".k2b-activity__icon")!;
        const icon = iconElement.getBoundingClientRect();
        // A compact list in a container sized by its content (a popover) keeps its width.
        const probe = document.createElement("div");
        probe.style.width = "max-content";
        probe.append(document.querySelector(".k2b-activity")!.cloneNode(true));
        document.body.append(probe);
        const fitted = probe.getBoundingClientRect().width;
        probe.remove();
        const body = row.querySelector(".k2b-activity__body")!.getBoundingClientRect();
        const text = getComputedStyle(row.querySelector(".k2b-activity__text")!);
        const meta = getComputedStyle(row.querySelector(".k2b-activity__meta")!);
        const day = document.querySelector<HTMLElement>(".k2b-activity__day")!;
        return {
          rail: [rail.width, rail.left, rail.borderStyle],
          // The rail pauses behind the icon (6 to 26 px) instead of a disc covering it, on any surface.
          gap: [rail.top, rail.height, below.top, below.width, below.left, getComputedStyle(iconElement).backgroundColor],
          fitted,
          icon: [icon.width, icon.left - list.left],
          column: body.left - icon.right,
          text: [text.fontSize, text.lineHeight],
          meta: [meta.fontSize, meta.lineHeight],
          day: [getComputedStyle(day).fontSize, getComputedStyle(day.querySelector(".k2b-activity__day-line")!).width],
          dash: getComputedStyle(day.querySelector(".k2b-activity__day-line")!).borderTopStyle,
        };
      });
      expect(geometry.rail.slice(0, 2)).toEqual(["2px", "17px"]);
      expect(geometry.icon).toEqual([20, 0]);
      expect(geometry.column).toBe(12);
      expect(geometry.gap).toEqual(["0px", "6px", "26px", "2px", "17px", "rgba(0, 0, 0, 0)"]);
      expect(geometry.fitted).toBeGreaterThan(200);
      expect(geometry.text).toEqual(["14px", "20px"]);
      expect(geometry.meta).toEqual(["13px", "18px"]);
      expect(geometry.day).toEqual(["12px", "22px"]);
      expect(geometry.dash).toBe("dashed");
    } finally {
      await page.context().close();
    }
  });

  test("a click on the row acts like its sentence, but not on links and the action inside it", async () => {
    const page = await load();
    try {
      // The card shows six rows; the row that opens is the fourth.
      const opening = page.locator(".k2b-activity__entry").filter({ hasText: "Über den Link geöffnet" });
      await opening.locator(".k2b-activity__meta").click();
      expect((await counters(page)).opened).toBe(1);
      await page.getByRole("button", { name: "Einladung erneut senden" }).click();
      expect(await counters(page)).toEqual({ opened: 1, acted: 1 });
      // Folding out details: the row and its sentence button do the same; a link inside the row does not.
      const mail = page.locator(".k2b-activity__entry").filter({ hasText: "Per E-Mail gesendet" });
      const sentence = mail.getByRole("button", { name: "Per E-Mail gesendet" });
      expect(await sentence.getAttribute("aria-expanded")).toBe("false");
      await mail.locator(".k2b-activity__meta").click();
      expect(await sentence.getAttribute("aria-expanded")).toBe("true");
      expect(await mail.locator(".k2b-activity__details").textContent()).toContain("Betreff");
      await sentence.click();
      expect(await mail.locator(".k2b-activity__details").count()).toBe(0);
    } finally {
      await page.context().close();
    }
  });

  test("'All N' opens the wide dialog with a filter that counts entries", async () => {
    const page = await load(1440);
    try {
      // 13 entries in 10 rows: the four drafts are one row.
      await page.getByRole("button", { name: "Alle 10" }).click();
      const dialog = page.locator("[data-activity-dialog]");
      await dialog.waitFor();
      await settled(page);
      expect(await dialog.locator(".k2b-activity").getAttribute("data-density")).toBe("wide");
      expect(await dialog.textContent()).toContain("Projekt Sommerfest");
      const chips = await dialog.locator(".k2b-choice-chips [role=radio]").allTextContents();
      expect(chips.map((chip) => chip.trim())).toEqual(["Alle 13", "E-Mails 3", "Änderungen 6", "Dateien 2"]);
      await dialog.getByRole("radio", { name: "Dateien 2" }).click();
      expect(await dialog.locator(".k2b-activity__entry").count()).toBe(2);
      // Wide: the meta line stands on the right of the first line.
      await dialog.getByRole("radio", { name: "Alle 13" }).click();
      await settled(page);
      const placement = await dialog
        .locator(".k2b-activity__entry")
        .first()
        .evaluate((row) => {
          const text = row.querySelector(".k2b-activity__text")!.getBoundingClientRect();
          const meta = row.querySelector(".k2b-activity__meta")!.getBoundingClientRect();
          return { sameLine: Math.round(meta.top) === Math.round(text.top), right: meta.left > text.left };
        });
      expect(placement).toEqual({ sameLine: true, right: true });
    } finally {
      await page.context().close();
    }
  });
});
