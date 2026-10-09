import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { SpaceColumn, SpaceItemTemplate, SpaceTag } from "@/contracts";
import { browserName, launchBrowser } from "../../../../../../ui/test/browser";
import { formatTemplateDate, proposeTemplateDates, templateSchedule } from "../../../../presentation/item-templates";
import { templateDraftSource } from "../shared/item-form/templates";

// The + flow is a layout and focus question, so the create button renders on the server and then runs its real island
// bundle in a real browser, as a Space page does. The island bundle resolves Solid from its root, so the scratch root
// sits inside this package's dependencies.
const packageCache = resolve(import.meta.dir, "../../../../../node_modules/.cache");
mkdirSync(packageCache, { recursive: true });
const root = mkdtempSync(join(packageCache, "spaces-templates-browser-"));
const { plugin } = createConfig({ dev: false, verbose: false, rootDir: root, componentRoots: [import.meta.dir] });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: ItemTemplatesFixture } = await import("./item-templates.browser-fixture");

const ui = resolve(import.meta.dir, "../../../../../../ui/dist");
const styleEntries = [
  resolve(import.meta.dir, "../../../../styles/app.css"),
  resolve(import.meta.dir, "../../../../../../cloud/src/styles/global.css"),
];
/** Light screenshots of the dialog, kept for review. */
const shots = join(tmpdir(), "spaces-item-templates", browserName);
const TIME_ZONE = "Europe/Berlin";

// Invented demo data: an operations team with recurring reports.
const columns: SpaceColumn[] = [{ id: "Col001", spaceId: "Space1", name: "To do", color: null, rank: "1", isDone: false }];
const report: SpaceTag = { id: "Tag001", spaceId: "Space1", name: "Report", color: "#8b5cf6" };
const stamps = { spaceId: "Space1", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" };
const taskTemplate = (id: string, name: string, patch: Partial<SpaceItemTemplate> = {}): SpaceItemTemplate => ({
  ...stamps,
  id,
  kind: "task",
  name,
  title: name,
  description: null,
  priority: null,
  tags: [],
  assignees: [],
  assignCreator: false,
  checklist: [],
  estimatedDurationMinutes: null,
  location: null,
  url: null,
  allDay: false,
  durationMinutes: null,
  timeOfDay: null,
  dateRule: { type: "none" },
  ...patch,
});
const weekly = taskTemplate("Tpl001", "Weekly report", {
  title: "Weekly report week {{week}}",
  description: "What happened, what is blocked, what comes next?",
  priority: "medium",
  tags: [report],
  assignCreator: true,
  checklist: ["Collect numbers", "Write the summary", "Send"],
  dateRule: { type: "weekdays", weekdays: ["WE", "TH"] },
});
const templates = [
  weekly,
  taskTemplate("Tpl002", "Release check", { dateRule: { type: "offset", days: 3 } }),
  taskTemplate("Tpl003", "Check invoices", { dateRule: { type: "weekdays", weekdays: ["MO"] } }),
  taskTemplate("Tpl004", "Prepare the board meeting"),
];

const serverBody = (locale: "en" | "de") =>
  renderToString(() =>
    createComponent(ItemTemplatesFixture, {
      locale,
      spaceId: "Space1",
      columns,
      tags: [report],
      templates,
      dateConfig: { locale, timeZone: TIME_ZONE, firstDayOfWeek: 1 },
      defaultType: "task",
    }),
  );

let css = "";
let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
const created: unknown[] = [];

beforeAll(async () => {
  const built = await Promise.all(styleEntries.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  css = [
    "@layer properties, theme, base, components, utilities;",
    ...(await Promise.all(built.map((build) => build.outputs[0]!.text()))),
  ].join("\n");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/_ssr/")) return new Response(Bun.file(join(root, url.pathname)));
      if (url.pathname.startsWith("/ui/")) return new Response(Bun.file(join(ui, url.pathname.slice(4))));
      if (url.pathname === "/api/spaces/Space1/items" && request.method === "POST") {
        const body = (await request.json()) as Record<string, unknown>;
        created.push(body);
        return Response.json({ id: "New001", spaceId: "Space1", startsAt: null, endsAt: null, ...body });
      }
      if (url.pathname.startsWith("/api/")) return Response.json({ message: "Not part of the + flow" }, { status: 404 });
      if (url.pathname !== "/app/spaces/Space1") return new Response("Not found", { status: 404 });
      const locale = url.searchParams.get("lang") === "de" ? "de" : "en";
      return new Response(pageHtml(locale), { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  browser = await launchBrowser();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

const pageHtml = (locale: "en" | "de") =>
  `<!doctype html><html lang="${locale}" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<link rel="stylesheet" href="/ui/plex.css"><link rel="stylesheet" href="/ui/tabler.css"><style>${css}</style>` +
  "<style>solid-client,solid-island{display:contents}</style></head>" +
  `<body class="k2b-ui" style="margin:0"><main style="padding:24px">${serverBody(locale)}</main>` +
  `<script type="module">document.querySelectorAll('solid-island').forEach((e)=>import('/_ssr/'+e.dataset.id+'.js'))</script></body></html>`;

type View = { width: number; height: number; touch: boolean };
const phone: View = { width: 390, height: 844, touch: true };
const desktop: View = { width: 1440, height: 900, touch: false };

const openDialog = async (view: View, locale: "en" | "de") => {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    isMobile: view.touch,
    hasTouch: view.touch,
    reducedMotion: "reduce",
    timezoneId: TIME_ZONE,
  });
  const page = await context.newPage();
  await page.goto(`${server.url}app/spaces/Space1?lang=${locale}`);
  await page.evaluate(() => window.document.fonts.ready);
  const button = page.getByRole("button", { name: locale === "de" ? "Neue Aufgabe" : "New task" });
  await page.waitForFunction(() => Boolean((window.document.querySelector("main button") as { $$click?: unknown } | null)?.$$click), {
    timeout: 15_000,
  });
  await button.click();
  await page.locator(".spaces-item-form").waitFor();
  await settle(page);
  return page;
};
const settle = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => setTimeout(done, 80))));
const tap = (page: Page, locator: ReturnType<Page["locator"]>) => (phoneView(page) ? locator.tap() : locator.click());
const phoneView = (page: Page) => (page.viewportSize()?.width ?? 1000) < 500;

/** The dialog panel and every form row, rounded to whole pixels: anything that moves shows up here. */
const layout = (page: Page) =>
  page.evaluate(() => {
    const box = (element: Element | null) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return [rect.left, rect.top, rect.width, rect.height].map(Math.round);
    };
    const form = window.document.querySelector(".spaces-item-form");
    return {
      panel: box(form?.closest("dialog > *") ?? form),
      rows: Array.from(form?.querySelectorAll(".k2b-field, .spaces-template-summary, .k2b-segmented-control") ?? [], box),
    };
  });
/** The chip row of a field: its height, a chip's height, whether it scrolls, and whether every chip shares one line. */
const chipRow = (page: Page, className: string) =>
  page.evaluate((name) => {
    const field = window.document.querySelector(`.${name}`)!;
    const row = field.querySelector<HTMLElement>(".k2b-choice-groups")!;
    const chips = Array.from(row.querySelectorAll<HTMLElement>("[role='radio']"));
    const tops = new Set(chips.map((chip) => Math.round(chip.getBoundingClientRect().top)));
    return {
      lines: tops.size,
      chipHeight: Math.round(chips[0]!.getBoundingClientRect().height),
      rowHeight: Math.round(row.getBoundingClientRect().height),
      scrolls: row.scrollWidth > row.clientWidth,
    };
  }, className);
const focusedPlaceholder = (page: Page) =>
  page.evaluate(() => (window.document.activeElement as HTMLInputElement | null)?.placeholder ?? "");
const shoot = async (page: Page, name: string) => {
  mkdirSync(shots, { recursive: true });
  await page.mouse.move(0, 0);
  await settle(page);
  await page.screenshot({ path: join(shots, `${name}.png`) });
};

describe(`Spaces templates in the + dialog in ${browserName}`, () => {
  for (const [label, view] of [
    ["desktop", desktop],
    ["phone", phone],
  ] as const) {
    test(`${label}: a template fills the form and proposes dates in one step without moving the dialog`, async () => {
      const page = await openDialog(view, "en");
      try {
        // The template row is there from the start, and focus stays in the title so a blank task is as quick as before.
        expect(await focusedPlaceholder(page)).toBe("What needs to be done?");
        const templateGroup = page.getByRole("radiogroup", { name: "Template" });
        expect(await templateGroup.getByRole("radio", { name: "Blank" }).getAttribute("aria-checked")).toBe("true");
        await shoot(page, `${label}-01-blank`);
        const blank = await layout(page);
        const row = await chipRow(page, "spaces-template-choice");
        expect(row.lines).toBe(1);
        if (view.touch) expect(row.chipHeight).toBeGreaterThanOrEqual(44);

        // Hovering or focusing a chip moves nothing.
        if (!view.touch) await templateGroup.getByRole("radio", { name: "Release check" }).hover();
        await templateGroup.getByRole("radio", { name: "Blank" }).focus();
        await settle(page);
        expect(await layout(page)).toEqual(blank);

        await tap(page, templateGroup.getByRole("radio", { name: "Weekly report" }));
        await settle(page);
        const proposals = proposeTemplateDates(weekly, { now: new Date(), timeZone: TIME_ZONE });
        const dates = page.getByRole("radiogroup", { name: "Due" });
        expect(await dates.getByRole("radio", { name: formatTemplateDate(proposals[0]!, "en") }).getAttribute("aria-checked")).toBe("true");
        expect(await page.locator("[data-testid='template-summary']").textContent()).toBe(
          "From the template: 3 checklist items · Report · Medium · You",
        );
        expect(await page.locator('input[placeholder="What needs to be done?"]').inputValue()).toStartWith("Weekly report week ");
        const dateRow = await chipRow(page, "spaces-template-dates");
        expect(dateRow.lines).toBe(1);
        if (view.touch) expect(dateRow.chipHeight).toBeGreaterThanOrEqual(44);
        await shoot(page, `${label}-02-template`);

        // Another proposal changes values only; no row grows or jumps.
        const filled = await layout(page);
        await tap(page, dates.getByRole("radio", { name: formatTemplateDate(proposals[1]!, "en") }));
        await settle(page);
        expect(await layout(page)).toEqual(filled);
        expect(await dates.getByRole("radio", { name: formatTemplateDate(proposals[1]!, "en") }).getAttribute("aria-checked")).toBe("true");

        await tap(page, page.getByRole("button", { name: "Create Task" }));
        await page.locator(".spaces-item-form").waitFor({ state: "detached" });
        expect(created.at(-1)).toMatchObject({
          columnId: "Col001",
          priority: "medium",
          tagIds: ["Tag001"],
          checklist: weekly.checklist,
          assignCreator: true,
          deadline: templateSchedule(templateDraftSource(weekly), proposals[1]!, TIME_ZONE).deadline,
        });
      } finally {
        await page.context().close();
      }
    }, 60_000);
  }

  test("German phone: labels, local date chips, and keyboard selection", async () => {
    const page = await openDialog(phone, "de");
    try {
      const group = page.getByRole("radiogroup", { name: "Vorlage" });
      await group.getByRole("radio", { name: "Leer" }).focus();
      await page.keyboard.press("ArrowRight");
      await settle(page);
      expect(await group.getByRole("radio", { name: "Weekly report" }).getAttribute("aria-checked")).toBe("true");
      const [first] = proposeTemplateDates(weekly, { now: new Date(), timeZone: TIME_ZONE });
      const dates = page.getByRole("radiogroup", { name: "Fällig" });
      expect(await dates.getByRole("radio", { name: formatTemplateDate(first!, "de") }).getAttribute("aria-checked")).toBe("true");
      expect(await page.getByText("Vorschlag aus der Vorlage · Mi oder Do · 17:00").count()).toBe(1);
      expect(await page.locator("[data-testid='template-summary']").textContent()).toBe(
        "Aus der Vorlage: 3 Checklistenpunkte · Report · Mittel · Du",
      );
      await tap(page, dates.getByRole("radio", { name: "Anderes Datum…" }));
      await settle(page);
      expect(await page.getByText("Fälligkeitsdatum").count()).toBeGreaterThan(0);
      await shoot(page, "phone-de-other-date");
    } finally {
      await page.context().close();
    }
  }, 60_000);
});
