/**
 * Page templates where people make notes: the sidebar's "New note" menu, the offer on an empty note, saving a note as
 * a template and the settings tab. Layout, focus and the menu popup need a real browser with the shipped stylesheets.
 * With NOTEBOOK_TEMPLATE_SHOTS=<dir>, the run also writes light screenshots of each state for review.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser, settled } from "../../../../../../ui/test/browser";
import type { PageTemplateSummary } from "../../../../lib/page-templates";
import type { NotebookContext } from "../sidebar/types";

setDefaultTimeout(30_000);
const ui = `${resolve(import.meta.dir, "../../../../../../ui")}/`;

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "page-templates.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-page-templates-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Page templates harness build failed");
  return build.outputs[0]!.text();
};

const buildCss = async (entry: string): Promise<string> => {
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", `${resolve(import.meta.dir, "../../../../../../cloud")}/`)))
    .default;
  const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}`);
  return build.outputs[0]!.text();
};

const own: PageTemplateSummary = {
  id: "Wk0001",
  name: "Weekly check-in",
  description: null,
  icon: "ti ti-template",
  builtIn: false,
  updatedAt: "2026-10-28T09:00:00.000Z",
};
const builtIns: PageTemplateSummary[] = [
  {
    id: "meeting-notes",
    name: "Meeting notes",
    description: "Agenda, decisions and action items",
    icon: "ti ti-users",
    builtIn: true,
    updatedAt: null,
  },
  {
    id: "project-page",
    name: "Project page",
    description: "Goal, milestones and open questions",
    icon: "ti ti-rocket",
    builtIn: true,
    updatedAt: null,
  },
  {
    id: "decision-record",
    name: "Decision",
    description: "Context, options and consequences",
    icon: "ti ti-scale",
    builtIn: true,
    updatedAt: null,
  },
];
const templates = [own, ...builtIns];
const drafts: Record<string, string> = {
  "meeting-notes":
    "# Meeting 2026-11-04\n\n- **Date:** 2026-11-04\n- **Notes by:** Mira Sander\n- **Participants:**\n\n## Agenda\n\n1.\n\n## Decisions\n\n| Decision | Owner | Due |\n| --- | --- | --- |\n|  |  |  |\n\n## Action items\n\n- [ ] \n",
};

const notebook = {
  id: "Book01",
  name: "Harbor team",
  description: null,
  icon: "ti ti-anchor",
  homepageNoteId: null,
  defaultPresentationMode: "write" as const,
  defaultNoteTitleTemplate: "New Document",
  noteDeletePermission: "write" as const,
  createdBy: null,
  createdAt: "2026-10-01T08:00:00.000Z",
  updatedAt: "2026-10-01T08:00:00.000Z",
};
const sidebarNote = (id: string, title: string) => ({
  id,
  parentId: null,
  title,
  position: 0,
  hasChildren: false,
  createdAt: "2026-10-20T08:00:00.000Z",
  updatedAt: "2026-10-20T08:00:00.000Z",
  lockedAt: null,
});
const notes = [sidebarNote("Note01", "Dock schedule"), sidebarNote("Note02", "New Document"), sidebarNote("Note03", "Supplier list")];
const ctx = (): NotebookContext => ({
  notebook,
  sidebarTree: { total: notes.length, levels: [{ parentId: null, total: notes.length, offset: 0, items: notes }], expandedIds: [] },
  sidebarList: null,
  selectedNoteId: "Note02",
  userId: "user-1",
  settings: { lastNoteId: null, richMode: "rich", treeSort: "title" },
  navigationHidden: false,
  fullWidth: false,
  permission: "write",
  attachmentCount: 0,
  favoriteNoteIds: [],
  tags: [],
  pageTemplates: templates,
  workspaceCursor: null,
  dateConfig: { locale: "en", timeZone: "UTC" },
  sidebarFilter: {},
});

/** What the fake server received, in order. */
const requests: { method: string; path: string; body?: unknown }[] = [];
let listDelay: Promise<void> = Promise.resolve();

const handleApi = async (request: Request, path: string): Promise<Response> => {
  const body = request.method === "GET" ? undefined : await request.json().catch(() => undefined);
  requests.push({ method: request.method, path, body });
  if (path === "workspace-state")
    return Response.json({ notebook, favoriteNoteIds: [], tags: [], attachmentCount: 0, pageTemplates: templates });
  if (path === "tree/levels") return Response.json({ levels: ctx().sidebarTree.levels, expandedIds: [] });
  if (path === "page-templates" && request.method === "GET") {
    await listDelay;
    return Response.json(templates);
  }
  const draft = /^page-templates\/([\w-]+)\/draft$/u.exec(path)?.[1];
  if (draft) return Response.json({ name: draft, contentMd: drafts[draft] ?? "# From template\n" });
  if (path === "page-templates" && request.method === "POST") {
    const name = (body as { name: string }).name;
    if (name.toLowerCase() === own.name.toLowerCase())
      return Response.json({ code: "CONFLICT", message: `A template named “${name}” already exists in this notebook.` }, { status: 409 });
    return Response.json({ ...own, id: "Wk0002", name }, { status: 201 });
  }
  if (path === "notes" && request.method === "POST")
    return Response.json({ ...sidebarNote("New001", "Meeting 2026-11-04"), notebookId: "Book01" });
  return Response.json({ message: "Not found" }, { status: 404 });
};

const fonts = dirname(fileURLToPath(import.meta.resolve("@k2b/ui/fonts/plex.css")));
const fontCss = await Bun.file(resolve(fonts, "plex.css")).text();
const iconCss = await Bun.file(resolve(fonts, "tabler.css")).text();
const iconFile = /tabler-icons-[\w-]+\.woff2/.exec(iconCss)?.[0];
const harness = await buildHarness();
const css =
  (await buildCss(resolve(import.meta.dir, "../../../../../../../styles.css"))) +
  (await buildCss(resolve(import.meta.dir, "../../../../styles/app.css"))) +
  (await Bun.file(resolve(ui, "src/styles/text-editor.css")).text());
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/notebooks/Book01/")) return handleApi(request, url.pathname.slice("/api/notebooks/Book01/".length));
    if (url.pathname.startsWith("/api/")) return Response.json({ data: [], pagination: { page: 1, per_page: 20, total: 0 } });
    if (url.pathname === "/plex.css") return new Response(fontCss, { headers: { "content-type": "text/css" } });
    if (url.pathname === "/tabler.css") return new Response(iconCss, { headers: { "content-type": "text/css" } });
    if (iconFile && url.pathname === `/${iconFile}`) return new Response(Bun.file(resolve(fonts, iconFile)));
    if (url.pathname.startsWith("/fonts/")) return new Response(Bun.file(resolve(fonts, "fonts", basename(url.pathname))));
    if (url.pathname === "/harness.js") return new Response(harness, { headers: { "content-type": "text/javascript; charset=utf-8" } });
    if (url.pathname === "/styles.css") return new Response(css, { headers: { "content-type": "text/css; charset=utf-8" } });
    return new Response(
      '<!doctype html><html class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<link rel="stylesheet" href="/plex.css"><link rel="stylesheet" href="/tabler.css"><link rel="stylesheet" href="/styles.css"></head>' +
        '<body class="k2b-ui" style="margin:0;height:100vh;display:flex;flex-direction:column">' +
        '<div id="root" style="display:flex;flex:1;min-height:0"></div><script src="/harness.js"></script></body></html>',
      { headers: { "content-type": "text/html" } },
    );
  },
});

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  server.stop(true);
});

const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const shots = process.env.NOTEBOOK_TEMPLATE_SHOTS;

const open = async (options: { device?: BrowserContextOptions; doc?: string; theme?: "light" | "dark"; locale?: string } = {}) => {
  const page = await (await browser.newContext(options.device ?? desktop)).newPage();
  await page.goto(new URL("/app/notebooks/Book01/notes/Note02", server.url).href);
  await page.evaluate((theme) => {
    document.documentElement.classList.remove("light", "dark");
    document.documentElement.classList.add(theme);
  }, options.theme ?? "light");
  await page.evaluate(({ value, locale, doc }) => window.mountTemplates(value, locale, doc), {
    value: ctx(),
    locale: options.locale ?? "en",
    doc: options.doc ?? "# New Document\n",
  });
  await page.waitForFunction(() => window.templateHarness.ready());
  return page;
};

const shoot = async (page: Page, motif: string, width: number) => {
  if (!shots) return;
  await mkdir(shots, { recursive: true });
  await settled(page);
  await page.screenshot({ path: resolve(shots, `${motif}-light-${width}.png`) });
};

describe("Notebook page templates", () => {
  test("an empty note offers templates below its title without moving the note, and a choice replaces it", async () => {
    let release = () => {};
    listDelay = new Promise((resolve) => {
      release = resolve;
    });
    const page = await open();
    try {
      const offer = page.locator("[data-notebook-empty-templates]");
      await offer.getByRole("status").waitFor();
      const loading = await page.evaluate(() => window.templateHarness.layout());
      release();
      await offer.getByRole("button", { name: "Meeting notes" }).waitFor();
      const loaded = await page.evaluate(() => window.templateHarness.layout());
      // The offer lies over the empty page: loading, the list, and no offer at all give the same note.
      expect(loaded).toEqual(loading);
      const box = (await offer.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(loaded.titleBottom - 1);
      expect(await offer.getByRole("button").allTextContents()).toEqual(["Weekly check-in", "Meeting notes", "Project page", "Decision"]);
      await shoot(page, "02-empty-note-offer", 1440);

      await offer.getByRole("button", { name: "Meeting notes" }).click();
      await page.waitForFunction(() => window.templateHarness.text().startsWith("# Meeting 2026-11-04"));
      expect(await page.evaluate(() => window.templateHarness.selection())).toBe("Meeting 2026-11-04");
      await offer.waitFor({ state: "detached" });
      await shoot(page, "03-empty-note-applied", 1440);
    } finally {
      listDelay = Promise.resolve();
      await page.context().close();
    }
  });

  test("the offer reads in dark mode and stays inside a phone's width", async () => {
    for (const [device, theme] of [
      [desktop, "dark"],
      [phone, "light"],
    ] as const) {
      const page = await open({ device, theme });
      try {
        const row = page.locator("[data-notebook-empty-templates]").getByRole("button", { name: "Meeting notes" });
        await row.waitFor();
        const contrast = await row.evaluate((element) => {
          const color = getComputedStyle(element).color;
          const background = getComputedStyle(document.body).backgroundColor;
          return color !== background;
        });
        expect(contrast).toBe(true);
        const box = (await row.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(device.viewport!.width);
        if (device === phone) await shoot(page, "02-empty-note-offer", 390);
      } finally {
        await page.context().close();
      }
    }
  });

  test("New note opens a menu: Enter twice still makes a blank note, a template row makes a note from it", async () => {
    const page = await open({ doc: "# Dock schedule\n\nMonday: crane\n" });
    try {
      const trigger = page.getByRole("button", { name: "New note", exact: true });
      const before = (await trigger.boundingBox())!;
      await trigger.click();
      const menu = page.getByRole("menu", { name: "New note" });
      await menu.waitFor();
      expect(await menu.getByRole("menuitem").allTextContents()).toEqual([
        "Blank note",
        "Weekly check-in",
        "Meeting notesAgenda, decisions and action items",
        "Project pageGoal, milestones and open questions",
        "DecisionContext, options and consequences",
        "Manage templates…",
      ]);
      // Opening the menu moves nothing in the sidebar head.
      expect(await trigger.boundingBox()).toEqual(before);
      await shoot(page, "01-new-note-menu", 1440);
      await menu.getByRole("menuitem", { name: "Meeting notes" }).click();
      await page.waitForFunction(() => window.openedNotes.length > 0);
      expect(requests.filter((entry) => entry.path === "notes").at(-1)?.body).toEqual({ templateId: "meeting-notes" });

      requests.length = 0;
      await trigger.focus();
      await page.keyboard.press("Enter");
      await menu.waitFor();
      expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Blank note");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => window.openedNotes.length > 1);
      expect(requests.filter((entry) => entry.path === "notes").at(-1)?.body).toEqual({});
    } finally {
      await page.context().close();
    }
  });

  test("Save as template keeps the name after a conflict and asks before replacing; Manage templates opens the settings tab", async () => {
    const page = await open({ doc: "# Dock schedule\n\nMonday: crane\n" });
    try {
      await page.getByRole("button", { name: "Actions for New Document" }).click();
      await page.getByRole("menuitem", { name: "Save as template…" }).click();
      const dialog = page.getByRole("dialog", { name: "Save as template" });
      const field = dialog.getByRole("textbox", { name: "Template name" });
      await field.waitFor();
      expect(await field.inputValue()).toBe("New Document");
      const height = (await dialog.boundingBox())!.height;
      await shoot(page, "04-save-as-template", 1440);
      await field.fill("weekly check-in");
      await dialog.getByRole("button", { name: "Save as template" }).click();
      await dialog.getByRole("button", { name: "Replace" }).waitFor();
      expect(await field.inputValue()).toBe("weekly check-in");
      // The question takes the hint's place, so the buttons stay where they were.
      expect((await dialog.boundingBox())!.height).toBe(height);
      await shoot(page, "05-save-as-template-replace", 1440);
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await dialog.waitFor({ state: "detached" });

      await page.getByRole("button", { name: "New note", exact: true }).click();
      await page.getByRole("menuitem", { name: "Manage templates…" }).click();
      const settings = page.getByRole("region", { name: "Notebook settings" });
      await settings.getByText("Templates of this notebook").waitFor();
      expect(await settings.getByText("Weekly check-in").count()).toBe(1);
      expect(await settings.getByRole("button", { name: "Rename Weekly check-in" }).count()).toBe(1);
      await shoot(page, "06-settings-templates", 1440);
    } finally {
      await page.context().close();
    }
  });
});
