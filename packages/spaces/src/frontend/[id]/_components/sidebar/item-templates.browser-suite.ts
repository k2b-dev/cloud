import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { SpaceColumn, SpaceItem, SpaceItemTemplate, SpaceTag } from "@/contracts";
import { checkFixtureSessionOrigin } from "../../../../../../../scripts/fixtures/session-origin";
import { browserName, hoverInPlace, launchBrowser } from "../../../../../../ui/test/browser";
import { registerSsrTestPlugin } from "../../../../../../ui/test/ssr-test-plugin";
import { formatTemplateDate, proposeTemplateDates, templateSchedule } from "../../../../presentation/item-templates";
import { templateDraftSource } from "../shared/item-form/templates";

// The + flow is a layout and focus question, so the Space page renders on the server and then runs its real island
// bundle in a real browser. The island bundle resolves Solid from its root, so the scratch root sits inside this
// package's dependencies.
const packageCache = resolve(import.meta.dir, "../../../../../node_modules/.cache");
mkdirSync(packageCache, { recursive: true });
const root = mkdtempSync(join(packageCache, "spaces-templates-browser-"));
registerSsrTestPlugin({ dev: false, verbose: false, rootDir: root, componentRoots: [resolve(import.meta.dir, "../workspace")] });

process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: ItemTemplatesFixture } = await import("./item-templates.browser-fixture");
const { TemplateForm } = await import("../edit/TemplatesSection");
const { templateFromItem } = await import("../edit/template-from-item");
const { LocaleProvider } = await import("@k2b/ui");

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
  icon: null,
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

// Nine templates give the + menu its search field.
const many = [
  ...templates,
  ...["Inventory", "Route plan", "Onboarding", "Order labels", "Complaint"].map((name, index) => taskTemplate(`Tpl10${index}`, name)),
];

const serverBody = (locale: "en" | "de", list = templates) =>
  renderToString(() =>
    createComponent(ItemTemplatesFixture, {
      locale,
      spaceId: "Space1",
      columns,
      tags: [report],
      templates: list,
      dateConfig: { locale, timeZone: TIME_ZONE, firstDayOfWeek: 1 },
    }),
  );

let css = "";
let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
const created: unknown[] = [];
const createdTemplates: Record<string, unknown>[] = [];
/** Templates the server keeps, so a retry can find one whose first save lost its answer. */
let storedTemplates: Record<string, unknown>[] = [];
const patchedTemplates: Record<string, unknown>[] = [];
/** How the next template saves answer: a server error first proves the retry keeps the input. */
let templateAnswers: number[] = [];

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
      const refused = await checkFixtureSessionOrigin(request);
      if (refused) return refused;
      const url = new URL(request.url);
      if (url.pathname.startsWith("/_ssr/")) return new Response(Bun.file(join(root, url.pathname)));
      if (url.pathname.startsWith("/ui/")) return new Response(Bun.file(join(ui, url.pathname.slice(4))));
      if (url.pathname === "/api/spaces/Space1/items" && request.method === "POST") {
        expect(request.headers.get("cookie")).toContain("session_token=fixture-session");
        const body = (await request.json()) as Record<string, unknown>;
        created.push(body);
        return Response.json({ id: "New001", spaceId: "Space1", startsAt: null, endsAt: null, ...body });
      }
      if (url.pathname === "/api/spaces/Space1/templates" && request.method === "GET") return Response.json(storedTemplates);
      // the people a template can assign: none in this Space
      if (url.pathname === "/api/spaces/Space1/assignable-users") return Response.json([]);
      // the list the page reloads after a save: still empty
      if (url.pathname === "/api/spaces/workspace/view")
        return Response.json({
          kind: "list",
          currentView: "list",
          itemsResult: { items: [], total: 0, page: 1, pageSize: 50, totalPages: 0, groupCounts: {} },
        });
      if (url.pathname === "/api/spaces/Space1/templates/Tpl900" && request.method === "PATCH") {
        const body = (await request.json()) as Record<string, unknown>;
        patchedTemplates.push(body);
        return Response.json({ ...taskTemplate("Tpl900", String(body.name)), ...body, id: "Tpl900" });
      }
      if (url.pathname === "/api/spaces/Space1/templates" && request.method === "POST") {
        const status = templateAnswers.shift() ?? 200;
        // 599 stands for a save whose answer got lost: the server kept the template.
        if (status === 599) storedTemplates.push({ ...taskTemplate("Tpl900", "x"), ...((await request.json()) as object), id: "Tpl900" });
        if (status !== 200) return Response.json({ message: "Server error" }, { status: status === 599 ? 502 : status });
        const body = (await request.json()) as Record<string, unknown>;
        createdTemplates.push(body);
        return Response.json({ ...taskTemplate("Tpl900", String(body.name)), ...body, id: "Tpl900" });
      }
      if (url.pathname.startsWith("/api/")) return Response.json({ message: "Not part of the + flow" }, { status: 404 });
      if (url.pathname !== "/app/spaces/Space1") return new Response("Not found", { status: 404 });
      const locale = url.searchParams.get("lang") === "de" ? "de" : "en";
      return new Response(pageHtml(locale, url.searchParams.has("many") ? many : templates), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "set-cookie": "session_token=fixture-session; Path=/; HttpOnly; SameSite=Lax",
        },
      });
    },
  });
  browser = await launchBrowser();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

const pageHtml = (locale: "en" | "de", list = templates) =>
  `<!doctype html><html lang="${locale}" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<link rel="stylesheet" href="/ui/plex.css"><link rel="stylesheet" href="/ui/tabler.css"><style>${css}</style>` +
  "<style>solid-client,solid-island{display:contents}</style></head>" +
  // The page as the Space page draws it: the v2 workspace fills the window.
  `<body class="k2b-ui" style="margin:0"><main class="k2-ui" style="display:flex;flex-direction:column;height:100dvh">${serverBody(locale, list)}</main>` +
  `<script type="module">document.querySelectorAll('solid-island').forEach((e)=>import('/_ssr/'+e.dataset.id+'.js'))</script></body></html>`;

type View = { width: number; height: number; touch: boolean };
const phone: View = { width: 390, height: 844, touch: true };
const desktop: View = { width: 1440, height: 900, touch: false };

/** Opens the Space page once its island runs: it has registered the Space's commands. */
const openPage = async (view: View, locale: "en" | "de", query = "") => {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    isMobile: view.touch,
    hasTouch: view.touch,
    reducedMotion: "reduce",
    timezoneId: TIME_ZONE,
  });
  const page = await context.newPage();
  await page.goto(`${server.url}app/spaces/Space1?lang=${locale}${query}`);
  await page.evaluate(() => window.document.fonts.ready);
  await page.waitForFunction(
    () => {
      const detail = { commands: [] as { id?: string }[] };
      window.dispatchEvent(new CustomEvent("cloud.command.collect", { detail }));
      return detail.commands.some((command) => command.id === "spaces.task.blank");
    },
    undefined,
    { timeout: 15_000 },
  );
  return page;
};
/** The head's "New task" menu; on the phone the main action stands at the bottom instead. */
const plus = (page: Page, locale: "en" | "de" = "en") =>
  page.locator('[data-slot="head"]').getByRole("button", { name: locale === "de" ? "Neue Aufgabe" : "New task" });
const mainAction = (page: Page, locale: "en" | "de" = "en") =>
  page.locator(".k2-fab", { hasText: locale === "de" ? "Neue Aufgabe" : "New task" });
const form = (page: Page) => page.getByRole("dialog");
/** A blank task: from the head's menu on a wide screen, from the main action on the phone (it starts one at once). */
const openDialog = async (view: View, locale: "en" | "de") => {
  const page = await openPage(view, locale);
  if (view.touch) await mainAction(page, locale).tap();
  else {
    await plus(page, locale).click();
    await page.getByRole("menuitem", { name: locale === "de" ? "Leere Aufgabe" : "Blank task" }).click();
  }
  await form(page).waitFor();
  await settle(page);
  return page;
};
const settle = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => setTimeout(done, 80))));
const tap = (page: Page, locator: ReturnType<Page["locator"]>) => (phoneView(page) ? locator.tap() : locator.click());
const phoneView = (page: Page) => (page.viewportSize()?.width ?? 1000) < 500;

/** The dialog and every field of the form, rounded to whole pixels: anything that moves shows up here. */
const layout = (page: Page) =>
  page.evaluate(() => {
    const box = (element: Element | null) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return [rect.left, rect.top, rect.width, rect.height].map(Math.round);
    };
    const dialog = window.document.querySelector('[role="dialog"]');
    return { panel: box(dialog), rows: Array.from(dialog?.querySelectorAll('[data-k2-part="Field"]') ?? [], box) };
  });
const focusedPlaceholder = (page: Page) =>
  page.evaluate(() => (window.document.activeElement as HTMLInputElement | null)?.placeholder ?? "");
const shoot = async (page: Page, name: string) => {
  mkdirSync(shots, { recursive: true });
  await page.mouse.move(0, 0);
  await settle(page);
  await page.screenshot({ path: join(shots, `${name}.png`) });
};
/** Picks an icon from the template form's icon select. */
const pickIcon = async (page: Page, dialog: ReturnType<Page["locator"]>, label: RegExp, icon: string) => {
  await dialog.getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: icon }).click();
};

describe(`Spaces templates in the new item dialog in ${browserName}`, () => {
  for (const [label, view] of [
    ["desktop", desktop],
    ["phone", phone],
  ] as const) {
    test(`${label}: a template fills the form and proposes dates in one step without moving the dialog`, async () => {
      const page = await openDialog(view, "en");
      try {
        // The template row is there from the start, and the title takes the focus so a blank task is as quick as before.
        // From 768 px the title takes the focus; on the phone the dialog keeps the keyboard closed.
        expect(await focusedPlaceholder(page)).toBe(view.touch ? "" : "What needs to be done?");
        const templateGroup = page.getByRole("radiogroup", { name: "Template" });
        expect(await templateGroup.getByRole("radio", { name: "Blank" }).isChecked()).toBe(true);
        await shoot(page, `${label}-01-blank`);
        const blank = await layout(page);

        // Hovering or focusing an option moves nothing.
        if (!view.touch) await hoverInPlace(templateGroup.getByText("Release check"));
        await templateGroup.getByRole("radio", { name: "Blank" }).focus();
        await settle(page);
        expect(await layout(page)).toEqual(blank);

        await tap(page, templateGroup.getByText("Weekly report"));
        await settle(page);
        const proposals = proposeTemplateDates(weekly, { now: new Date(), timeZone: TIME_ZONE });
        const dates = page.getByRole("radiogroup", { name: "Due" });
        expect(await dates.getByRole("radio", { name: formatTemplateDate(proposals[0]!, "en") }).isChecked()).toBe(true);
        expect(await page.getByText("From the template: 3 checklist items · Report · Medium · You").count()).toBe(1);
        expect(await page.locator('input[placeholder="What needs to be done?"]').inputValue()).toStartWith("Weekly report week ");
        await shoot(page, `${label}-02-template`);

        // Another proposal changes values only; no row grows or jumps.
        const filled = await layout(page);
        await tap(page, dates.getByText(formatTemplateDate(proposals[1]!, "en"), { exact: true }));
        await settle(page);
        expect(await layout(page)).toEqual(filled);
        expect(await dates.getByRole("radio", { name: formatTemplateDate(proposals[1]!, "en") }).isChecked()).toBe(true);

        await tap(page, form(page).getByRole("button", { name: "Create Task" }));
        await form(page).waitFor({ state: "detached" });
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

  test("German phone: labels, local date options, and keyboard selection", async () => {
    const page = await openDialog(phone, "de");
    try {
      const group = page.getByRole("radiogroup", { name: "Vorlage" });
      await group.getByRole("radio", { name: "Leer" }).focus();
      await page.keyboard.press("ArrowRight");
      await settle(page);
      expect(await group.getByRole("radio", { name: "Weekly report" }).isChecked()).toBe(true);
      const [first] = proposeTemplateDates(weekly, { now: new Date(), timeZone: TIME_ZONE });
      const dates = page.getByRole("radiogroup", { name: "Fällig" });
      expect(await dates.getByRole("radio", { name: formatTemplateDate(first!, "de") }).isChecked()).toBe(true);
      expect(await page.getByText("Vorschlag aus der Vorlage · Mi oder Do · ganztägig").count()).toBe(1);
      expect(await page.getByText("Aus der Vorlage: 3 Checklistenpunkte · Report · Mittel · Du").count()).toBe(1);
      await tap(page, dates.getByText("Anderes Datum…"));
      await settle(page);
      expect(await page.getByText("Fälligkeitsdatum").count()).toBeGreaterThan(0);
      await shoot(page, "phone-de-other-date");
    } finally {
      await page.context().close();
    }
  }, 60_000);

  test("the head's New task: Enter opens its menu with the blank task first, Enter again opens the blank dialog", async () => {
    const page = await openPage(desktop, "en");
    try {
      const button = plus(page);
      expect(await button.getAttribute("aria-haspopup")).toBe("menu");
      await button.focus();
      await page.keyboard.press("Enter");
      const menu = page.getByRole("menu");
      await menu.waitFor();
      await settle(page);
      const entries = await menu.getByRole("menuitem").allTextContents();
      expect(entries[0]).toStartWith("Blank task");
      for (const template of templates) expect(entries.some((entry) => entry.startsWith(template.name))).toBe(true);
      expect(entries.at(-1)).toStartWith("Create template…");
      await shoot(page, "desktop-03-menu");
      await page.keyboard.press("Enter");
      await form(page).waitFor();
      await settle(page);
      expect(await page.getByRole("radiogroup", { name: "Template" }).getByRole("radio", { name: "Blank" }).isChecked()).toBe(true);
    } finally {
      await page.context().close();
    }
  }, 60_000);

  test("a template from the menu opens the dialog with it chosen", async () => {
    const page = await openPage(desktop, "en");
    try {
      await plus(page).click();
      await page.getByRole("menuitem", { name: /^Weekly report/ }).click();
      await form(page).waitFor();
      await settle(page);
      const group = page.getByRole("radiogroup", { name: "Template" });
      expect(await group.getByRole("radio", { name: "Weekly report" }).isChecked()).toBe(true);
      expect(await page.locator('input[placeholder="What needs to be done?"]').inputValue()).toStartWith("Weekly report week ");
      await shoot(page, "desktop-04-from-menu");
    } finally {
      await page.context().close();
    }
  }, 60_000);

  // Pending (written OK of the coordinator, 26.11.): a v2 menu cannot search yet. Lane N builds "Menu with search"
  // (as the "+ Filter" search, with a no-match row); this case must pass again before #4197 goes ready.
  test.todo("nine templates: the menu searches, and a query without a match becomes the blank task's title", () => {});

  test("Create template: a taken name marks the field, a failed save keeps the input and tries again", async () => {
    const page = await openPage(desktop, "de");
    templateAnswers = [500];
    try {
      await plus(page, "de").click();
      await page.getByRole("menuitem", { name: "Vorlage erstellen …" }).click();
      const dialog = page.getByRole("dialog", { name: "Neue Aufgabenvorlage" });
      await dialog.waitFor();
      await settle(page);
      const name = dialog.getByRole("textbox", { name: /^Name/ });
      await name.fill("Weekly report");
      await dialog.getByRole("button", { name: "Vorlage speichern" }).click();
      await settle(page);
      expect(await dialog.getByText("Es gibt schon eine Vorlage mit diesem Namen.").isVisible()).toBe(true);
      await shoot(page, "desktop-07-name-taken");
      await name.fill("Wareneingang prüfen");
      await pickIcon(page, dialog, /^Symbol/, "package");
      await dialog.getByRole("button", { name: "Vorlage speichern" }).click();
      await dialog.getByRole("alert").waitFor();
      expect(await dialog.getByRole("alert").textContent()).toContain(
        "Die Vorlage konnte nicht gespeichert werden. Deine Eingaben bleiben.",
      );
      expect(await name.inputValue()).toBe("Wareneingang prüfen");
      await shoot(page, "desktop-08-save-failed");
      await dialog.getByRole("button", { name: "Erneut versuchen" }).click();
      await dialog.waitFor({ state: "detached" });
      expect(createdTemplates.at(-1)).toMatchObject({ kind: "task", name: "Wareneingang prüfen", icon: "ti ti-package" });
      await page.getByText("Vorlage „Wareneingang prüfen“ gespeichert · steht jetzt unter „+“").waitFor();
    } finally {
      templateAnswers = [];
      await page.context().close();
    }
  }, 60_000);

  test("phone: the main action starts a blank task at once, and its form offers the templates", async () => {
    const page = await openPage(phone, "de");
    try {
      const action = mainAction(page, "de");
      expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await action.tap();
      await form(page).waitFor();
      await settle(page);
      expect(await page.getByRole("radiogroup", { name: "Vorlage" }).getByRole("radio", { name: "Leer" }).isChecked()).toBe(true);
      await shoot(page, "phone-03-blank");
    } finally {
      await page.context().close();
    }
  }, 60_000);

  test("Save as template: the form starts from the item and offers the week and the weekday", async () => {
    const item = {
      id: "Itm001",
      spaceId: "Space1",
      columnId: "Col001",
      title: "Wochenbericht KW 44",
      description: null,
      priority: null,
      tags: [report],
      assignees: [],
      deadline: "2026-10-30T15:00:00.000Z",
      estimatedDurationMinutes: 30,
      startsAt: null,
      endsAt: null,
      allDay: false,
      location: null,
      url: null,
    } as unknown as SpaceItem;
    const { draft, suggestions } = templateFromItem(item, {
      checklist: ["Zahlen aus Grids holen", "Offene Reklamationen zählen", "Bericht an Team schicken"].map((label, index) => ({
        id: `Chk00${index}`,
        label,
        completed: index === 0,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      })),
      dateConfig: { locale: "de", timeZone: TIME_ZONE },
    });
    // The dialog as the server draws it: what the person sees first, before they answer a suggestion.
    const html = renderToString(() =>
      createComponent(LocaleProvider, {
        locale: "de",
        get children() {
          return createComponent(TemplateForm, {
            title: "Als Vorlage speichern",
            spaceId: "Space1",
            kind: draft.kind,
            draft,
            suggestions,
            tags: [report],
            timeZone: TIME_ZONE,
            loading: false,
            variant: "dialog",
            onCancel: () => {},
            onSave: () => {},
          });
        },
      }),
    );
    expect(html).toContain("„KW 44“ durch {{week}} ersetzen, damit jede Woche passt?");
    expect(html).toContain("War freitags fällig. Freitage vorschlagen?");
  }, 60_000);

  test("a retry after a save whose answer got lost keeps the corrections and saves no second template", async () => {
    const page = await openPage(desktop, "de");
    templateAnswers = [599];
    storedTemplates = [];
    const before = createdTemplates.length;
    try {
      await plus(page, "de").click();
      await page.getByRole("menuitem", { name: "Vorlage erstellen …" }).click();
      const dialog = page.getByRole("dialog", { name: "Neue Aufgabenvorlage" });
      await dialog.waitFor();
      await dialog.getByRole("textbox", { name: /^Name/ }).fill("Inventur");
      await dialog.getByRole("button", { name: "Vorlage speichern" }).click();
      await dialog.getByRole("alert").waitFor();
      await dialog.getByRole("textbox", { name: /^Titel/ }).fill("Inventur Regal {{week}}");
      await dialog.getByRole("button", { name: "Erneut versuchen" }).click();
      await dialog.waitFor({ state: "detached" });
      expect(createdTemplates.length).toBe(before);
      expect(patchedTemplates.at(-1)).toMatchObject({ name: "Inventur", title: "Inventur Regal {{week}}" });
    } finally {
      templateAnswers = [];
      storedTemplates = [];
      await page.context().close();
    }
  }, 60_000);
});
