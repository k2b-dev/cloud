import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { AiConversation } from "@k2b/cloud/ai";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser } from "../../../ui/test/browser";

// Whether a status change or hover moves the chat list is a layout result of the shipped cascade, which happy-dom
// does not model. A real engine lays out the sidebar before and after.

const ui = resolve(import.meta.dir, "../../../ui");
const entry = resolve(import.meta.dir, "AssistantSidebar.browser-entry.tsx");
const entrySource = `
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { AppWorkspace, LocaleProvider, Navigation, Select, TextInput } from "@k2b/ui";
import AssistantSidebar from ${JSON.stringify(resolve(import.meta.dir, "AssistantSidebar.tsx"))};
import { createAssistantLiveHub } from ${JSON.stringify(resolve(import.meta.dir, "assistant-live.tsx"))};

const [conversations, setConversations] = createSignal(window.harness.conversations);
window.sidebar = { setConversations };
render(
  () => (
    <LocaleProvider locale="de">
      <AppWorkspace class="harness-workspace">
        <AssistantSidebar timeZone="Europe/Berlin" renderedAt={new Date().toISOString()} conversations={conversations} live={createAssistantLiveHub()} />
        <AppWorkspace.Content>
          <AppWorkspace.Main>main</AppWorkspace.Main>
        </AppWorkspace.Content>
      </AppWorkspace>
    </LocaleProvider>
  ),
  document.getElementById("root"),
);
// The phone menu renders the navigation the sidebar provides, as the Cloud shell's bottom sheet does.
render(
  () => (
    <LocaleProvider locale="de">
      <Navigation navigation={window.__cloudWorkspaceNavigation.navigation} label="Assistent" />
    </LocaleProvider>
  ),
  document.getElementById("menu"),
);
// The All chats dialog's search and filter row, with the dialog's controls.
render(
  () => (
    <LocaleProvider locale="de">
      <div class="assistant-all-chats-filters">
        <TextInput type="search" icon="ti ti-search" aria-label="Chats durchsuchen" value={() => "Rechnungen"} clearable onClear={() => {}} />
        <Select aria-label="Chat-Filter" value={() => "needs_attention"} options={[{ value: "all", label: "Alle Chats" }, { value: "needs_attention", label: "Wartet auf dich" }]} />
      </div>
    </LocaleProvider>
  ),
  document.getElementById("filters"),
);
`;

// One fixed clock for the fixtures and the page: noon in Berlin, far from the midnight that changes the sections.
const now = Date.parse("2026-10-08T10:00:00.000Z");
const conversation = (id: string, title: string, hoursAgo: number, overrides: Partial<AiConversation> = {}): AiConversation => ({
  id,
  shortId: id,
  title,
  titleSource: "default",
  description: "",
  descriptionSource: "default",
  keywords: [],
  pinnedAt: null,
  done: null,
  isDone: false,
  lastUsedAt: new Date(now - hoursAgo * 3_600_000).toISOString(),
  archivedAt: null,
  runStatus: "idle",
  runError: null,
  unreadCompletion: false,
  projectId: null,
  draft: { content: [], revision: 0, updatedAt: null },
  createdByUserId: "user123",
  createdAt: "2026-08-12T08:00:00.000Z",
  updatedAt: "2026-08-12T08:00:00.000Z",
  ...overrides,
});

const quiet = [
  conversation("pinned", "Wochenbericht Vertrieb", 400, { pinnedAt: "2026-09-01T08:00:00.000Z" }),
  conversation("offer", "Angebot an Jana Berger mit einem sehr langen Titel, der nicht in die Zeile passt", 0.01),
  conversation("invoices", "Rechnungen Oktober", 0.02),
  conversation("travel", "Reise nach Lyon", 72),
  conversation("vacation", "Urlaubsplanung 2027", 24 * 60),
];
const busy: AiConversation[] = quiet.map((item) =>
  item.id === "offer"
    ? { ...item, runStatus: "needs_attention" }
    : item.id === "invoices"
      ? { ...item, runStatus: "running", activity: { completed: 1, total: 3, step: "Liest Rechnungen", tool: "Mail" } }
      : item.id === "travel"
        ? { ...item, runStatus: "failed", runError: "Model unavailable" }
        : item.id === "vacation"
          ? { ...item, unreadCompletion: true, hasActiveSchedule: true }
          : item,
);

let browser: Browser;
let css: string;
let script: string;
beforeAll(async () => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [entry],
    files: { [entry]: entrySource },
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-dom",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const source = path === entry ? entrySource : await Bun.file(path).text();
            const result = await transformAsync(source, {
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
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the Assistant sidebar harness.");
  script = await build.outputs[0]!.text();
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", resolve(import.meta.dir, "../../../cloud")))).default;
  const stylesheets = [resolve(import.meta.dir, "../styles/app.css"), resolve(import.meta.dir, "../../../../styles.css")];
  const outputs = await Promise.all(
    stylesheets.map(async (path) => {
      const output = await Bun.build({ entrypoints: [path], plugins: [tailwind] });
      if (!output.success) throw new AggregateError(output.logs, `Could not compile ${path}.`);
      return output.outputs[0]!.text();
    }),
  );
  css = ["@layer properties, theme, base, components, utilities;", ...outputs].join("\n");
  browser = await launchBrowser();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (conversations: AiConversation[], width = 1280): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  // The phone menu sits below the workspace at the width of the bottom sheet's body on a 390 px phone.
  const html =
    `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style></head>` +
    `<body class="k2b-ui" style="margin:0"><div id="root" style="display:flex;height:100vh"></div>` +
    `<div id="menu" style="width:358px;padding:0 16px"></div>` +
    `<div id="filters" style="width:${width > 1024 ? 718 : 332}px"></div>` +
    `<script>window.harness = ${JSON.stringify({ conversations })};</script></body></html>`;
  await page.clock.setFixedTime(now);
  await page.route("http://assistant.test/", (route) => route.fulfill({ body: html, contentType: "text/html" }));
  await page.goto("http://assistant.test/");
  page.setDefaultTimeout(4000);
  await page.addScriptTag({ content: script });
  await page
    .locator(width > 1024 ? ".assistant-chat-sidebar-item" : "#menu .k2b-navigation__row")
    .first()
    .waitFor();
  return page;
};

/** Every open chat row and section heading of the desktop list, by position. */
const rows = (page: Page) =>
  page.evaluate(() => {
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    const list = document.querySelector('.k2b-app-workspace__sidebar-body[data-sidebar-mode="expanded"]')!;
    return {
      headings: Array.from(list.querySelectorAll("h2"), (heading) => ({ text: heading.textContent, ...box(heading) })),
      rows: Array.from(
        list.querySelectorAll(".k2b-app-workspace__sidebar-section:not([data-collapsible]) .assistant-chat-sidebar-item"),
        (row) => ({
          title: row.querySelector(".k2b-app-workspace__sidebar-item-label-text")?.textContent,
          marker: row.querySelector(".assistant-chat-marker")?.getAttribute("data-tone") ?? null,
          label: box(row.querySelector(".k2b-app-workspace__sidebar-item-label")!),
          ...box(row),
        }),
      ),
    };
  });

/** Every section heading and row of the phone menu, by position, with the status the row shows. */
const menuRows = (page: Page) =>
  page.evaluate(() => {
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    const menu = document.getElementById("menu")!;
    return {
      headings: Array.from(menu.querySelectorAll(".k2b-navigation__heading"), (heading) => ({
        text: heading.textContent,
        ...box(heading),
      })),
      rows: Array.from(menu.querySelectorAll(".k2b-navigation__row"), (row) => ({
        title: row.querySelector(".k2b-navigation__copy")?.textContent,
        status: row.querySelector(".k2b-navigation__status")?.getAttribute("data-tone") ?? null,
        label: box(row.querySelector(".k2b-navigation__copy")!),
        ...box(row),
      })),
    };
  });

const frames = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
const withoutMarkers = <T extends { marker: string | null }>(items: T[]) => items.map(({ marker: _marker, ...rest }) => rest);

describe(`Assistant chat list in ${browserName}`, () => {
  test("rows sit under day headings, one line each, and a status change moves nothing", async () => {
    const page = await open(quiet);
    try {
      const before = await rows(page);
      expect(before.headings.map((heading) => heading.text)).toEqual(["Angeheftet", "Heute", "Letzte 7 Tage", "Älter"]);
      expect(new Set(before.rows.map((row) => row.height)).size).toBe(1);
      expect(before.rows.every((row) => row.marker === null)).toBe(true);

      await page.evaluate(
        (json) =>
          (window as unknown as { sidebar: { setConversations: (value: unknown) => void } }).sidebar.setConversations(JSON.parse(json)),
        JSON.stringify(busy),
      );
      await frames(page);
      const after = await rows(page);
      expect(after.rows.map((row) => [row.title, row.marker])).toEqual([
        ["Wochenbericht Vertrieb", null],
        ["Angebot an Jana Berger mit einem sehr langen Titel, der nicht in die Zeile passt", "attention"],
        ["Rechnungen Oktober", "progress"],
        ["Reise nach Lyon", "danger"],
        ["Urlaubsplanung 2027", "accent"],
      ]);
      // Same boxes for every row and heading: the marker shares the title's line instead of adding one.
      expect(after.headings).toEqual(before.headings);
      expect(withoutMarkers(after.rows).map(({ label: _label, ...row }) => row)).toEqual(
        withoutMarkers(before.rows).map(({ label: _label, ...row }) => row),
      );
    } finally {
      await page.close();
    }
  });

  test("the phone menu shows the same day sections, and a status change moves no row or heading", async () => {
    const page = await open(quiet, 390);
    try {
      const before = await menuRows(page);
      expect(before.headings.map((heading) => heading.text)).toEqual(["Angeheftet", "Heute", "Letzte 7 Tage", "Älter"]);
      // The long title wraps; the slot for a later status is already taken out of its width.
      const offer = before.rows.find((row) => row.title?.startsWith("Angebot"))!;
      expect(offer.label.height).toBeGreaterThan(before.rows.find((row) => row.title === "Rechnungen Oktober")!.label.height);

      await page.evaluate(
        (json) =>
          (window as unknown as { sidebar: { setConversations: (value: unknown) => void } }).sidebar.setConversations(JSON.parse(json)),
        JSON.stringify(busy),
      );
      await frames(page);
      const after = await menuRows(page);
      const chats = (rows: typeof after.rows) => rows.filter((row) => quiet.some((item) => item.title === row.title));
      expect(chats(after.rows).map((row) => [row.title, row.status])).toEqual([
        ["Wochenbericht Vertrieb", null],
        ["Angebot an Jana Berger mit einem sehr langen Titel, der nicht in die Zeile passt", "warning"],
        ["Rechnungen Oktober", "neutral"],
        ["Reise nach Lyon", "danger"],
        ["Urlaubsplanung 2027", "info"],
      ]);
      expect(after.headings).toEqual(before.headings);
      const boxes = (rows: typeof after.rows) => rows.map(({ status: _status, ...row }) => row);
      expect(boxes(after.rows)).toEqual(boxes(before.rows));
    } finally {
      await page.close();
    }
  });

  test.each([
    [390, "stacks search over the filter, each at full width"],
    [1280, "keeps search and filter on one row, the search taking the rest"],
  ])("All chats filters at %i px %s", async (width) => {
    const page = await open(quiet, width);
    try {
      const [search, filter] = await page.evaluate(() =>
        Array.from(document.querySelectorAll("#filters .assistant-all-chats-filters > *"), (element) => {
          const rect = element.getBoundingClientRect();
          return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width) };
        }),
      );
      if (width === 390) {
        expect(search!.width).toBe(332);
        expect(filter!.width).toBe(332);
        expect(filter!.y).toBeGreaterThan(search!.y);
      } else {
        expect(filter!.y).toBe(search!.y);
        expect(filter!.width).toBe(208);
        expect(search!.width).toBe(718 - 208 - 8);
      }
    } finally {
      await page.close();
    }
  });

  test("hovering a row reveals its Done action over the row's end without moving the title", async () => {
    const page = await open(quiet);
    try {
      const before = await rows(page);
      const target = page.locator(".assistant-chat-sidebar-item", { hasText: "Rechnungen Oktober" }).first();
      await target.hover();
      await frames(page);
      const done = target.getByRole("button", { name: "Chat als fertig markieren" });
      await expect(done.isVisible()).resolves.toBe(true);
      const after = await rows(page);
      expect(after.rows.map((row) => ({ x: row.x, y: row.y, height: row.height, labelX: row.label.x, labelY: row.label.y }))).toEqual(
        before.rows.map((row) => ({ x: row.x, y: row.y, height: row.height, labelX: row.label.x, labelY: row.label.y })),
      );
    } finally {
      await page.close();
    }
  });
});
