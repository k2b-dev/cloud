import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
const [activeConversationId, setActiveConversationId] = createSignal(window.harness.activeConversationId ?? null);
window.sidebar = { setConversations, setActiveConversationId };
render(
  () => (
    <LocaleProvider locale="de">
      <AppWorkspace class="harness-workspace">
        <AssistantSidebar
          timeZone="Europe/Berlin"
          renderedAt={new Date().toISOString()}
          conversations={conversations}
          activeConversationId={activeConversationId}
          live={createAssistantLiveHub()}
        />
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
          ? { ...item, unreadCompletion: true }
          : item,
);

let browser: Browser;
let assets: ReturnType<typeof Bun.serve>;
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
  // Icons and the typeface load from @k2b/ui's build, so a status glyph shows and measures as it does in Cloud.
  const fonts = ["plex.css", "tabler.css"]
    .map((file) => readFileSync(resolve(ui, "dist", file), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, "url($1/ui/"))
    .join("\n");
  css = [fonts, "@layer properties, theme, base, components, utilities;", ...outputs].join("\n");
  // Large bundles travel over HTTP, not as an inline Playwright protocol argument.
  assets = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/bundle.js") return new Response(script, { headers: { "content-type": "text/javascript" } });
      if (path.startsWith("/ui/")) return new Response(Bun.file(resolve(ui, "dist", path.slice(4))));
      return new Response("Not found", { status: 404 });
    },
  });
  browser = await launchBrowser();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  assets?.stop(true);
});

const open = async (
  conversations: AiConversation[],
  width = 1280,
  options: { activeConversationId?: string; reducedMotion?: boolean } = {},
): Promise<Page> => {
  const page = await browser.newPage({
    viewport: { width, height: 800 },
    reducedMotion: options.reducedMotion ? "reduce" : "no-preference",
  });
  // The phone menu sits below the workspace at the width of the bottom sheet's body on a 390 px phone.
  const html =
    `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style></head>` +
    `<body class="k2b-ui" style="margin:0"><div id="root" style="display:flex;height:100vh"></div>` +
    `<div id="menu" style="width:358px;padding:0 16px"></div>` +
    `<div id="filters" style="width:${width > 1024 ? 718 : 332}px"></div>` +
    `<script>window.harness = ${JSON.stringify({ conversations, activeConversationId: options.activeConversationId })};</script></body></html>`;
  await page.clock.setFixedTime(now);
  await page.route(assets.url.href, (route) => route.fulfill({ body: html, contentType: "text/html" }));
  await page.goto(assets.url.href);
  page.setDefaultTimeout(4000);
  await page.addScriptTag({ type: "module", url: new URL("bundle.js", assets.url).href });
  await page
    .locator(width > 1024 ? ".assistant-chat-sidebar-item" : "#menu .k2b-navigation__row")
    .first()
    .waitFor();
  await page.evaluate(() => document.fonts.ready);
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
      // The running mark carries the AI's plum and the unread answer a real dot, in the menu's neutral tones too.
      const marks = await page.evaluate(() =>
        Array.from(document.querySelectorAll("#menu .k2b-navigation__status > i"), (glyph) => {
          const style = getComputedStyle(glyph);
          const rect = glyph.getBoundingClientRect();
          return {
            title: glyph.closest(".k2b-navigation__row")?.querySelector(".k2b-navigation__copy")?.textContent,
            ink:
              style.backgroundColor !== "rgba(0, 0, 0, 0)"
                ? rect.width
                : getComputedStyle(glyph, "::before").content !== "none"
                  ? rect.width
                  : 0,
            color: style.backgroundColor !== "rgba(0, 0, 0, 0)" ? style.backgroundColor : style.color,
          };
        }),
      );
      const plum = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.color = "var(--k2b-ai-accent)";
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      expect(marks.every((mark) => mark.ink >= 8)).toBe(true);
      expect(marks.find((mark) => mark.title === "Rechnungen Oktober")?.color).toBe(plum);
      expect(marks.find((mark) => mark.title === "Urlaubsplanung 2027")?.color).not.toBe(plum);
      expect(after.headings).toEqual(before.headings);
      const boxes = (rows: typeof after.rows) => rows.map(({ status: _status, ...row }) => row);
      expect(boxes(after.rows)).toEqual(boxes(before.rows));
    } finally {
      await page.close();
    }
  });

  test("every state shows at icon size in its own color, the open row included, and a run starting or ending moves nothing", async () => {
    const page = await open(quiet, 1280, { activeConversationId: "invoices" });
    try {
      const set = (conversations: AiConversation[]) =>
        page.evaluate(
          (json) =>
            (window as unknown as { sidebar: { setConversations: (value: unknown) => void } }).sidebar.setConversations(JSON.parse(json)),
          JSON.stringify(conversations),
        );
      /** Each row's marker as the person sees it: its glyph's size and color, and whether anything covers it. */
      const markers = () =>
        page.evaluate(() => {
          const probe = document.createElement("span");
          document.body.append(probe);
          const token = (name: string) => {
            probe.style.color = `var(${name})`;
            return getComputedStyle(probe).color;
          };
          const tokens = { plum: token("--k2b-ai-accent"), action: token("--k2b-action"), danger: token("--k2b-danger-text") };
          probe.remove();
          const named = (color: string) => Object.entries(tokens).find(([, value]) => value === color)?.[0] ?? color;
          const list = document.querySelector('.k2b-app-workspace__sidebar-body[data-sidebar-mode="expanded"]')!;
          return Array.from(
            list.querySelectorAll(".k2b-app-workspace__sidebar-section:not([data-collapsible]) .assistant-chat-sidebar-item"),
            (row) => {
              const glyph = row.querySelector<HTMLElement>(".assistant-chat-marker > i");
              if (!glyph) return null;
              const rect = glyph.getBoundingClientRect();
              const style = getComputedStyle(glyph);
              const dot = style.backgroundColor !== "rgba(0, 0, 0, 0)";
              // A glyph's ink is its pseudo-element's; a dot's is its own box.
              const size = dot ? rect.width : Number.parseFloat(getComputedStyle(glyph, "::before").fontSize);
              const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
              return {
                kind: dot ? "dot" : "glyph",
                color: named(dot ? style.backgroundColor : style.color),
                visible:
                  size >= 8 && (dot || getComputedStyle(glyph, "::before").content !== "none") && Boolean(hit && glyph.contains(hit)),
                bold: Number(getComputedStyle(row.querySelector(".k2b-app-workspace__sidebar-item-label-text")!).fontWeight) >= 600,
              };
            },
          );
        });
      const boxes = async () => {
        const current = await rows(page);
        return {
          headings: current.headings,
          rows: current.rows.map(({ marker: _marker, label, ...row }) => ({
            ...row,
            labelX: label.x,
            labelY: label.y,
            labelHeight: label.height,
          })),
        };
      };

      const before = await boxes();
      await set(busy);
      await frames(page);
      // "Rechnungen Oktober" is the open chat and runs: its status keeps the row's end, no disabled Done check covers it.
      expect(await markers()).toEqual([
        null,
        { kind: "dot", color: "plum", visible: true, bold: false },
        { kind: "glyph", color: "plum", visible: true, bold: false },
        { kind: "glyph", color: "danger", visible: true, bold: false },
        { kind: "dot", color: "action", visible: true, bold: true },
      ]);
      expect(
        await page
          .locator(".assistant-chat-sidebar-item", { hasText: "Rechnungen Oktober" })
          .getByRole("button", { name: /fertig/ })
          .count(),
      ).toBe(0);
      expect(await boxes()).toEqual(before);

      // The run ends: the open row gets its Done action back, over the same end.
      await set(quiet);
      await frames(page);
      expect(
        await page
          .locator(".assistant-chat-sidebar-item", { hasText: "Rechnungen Oktober" })
          .getByRole("button", { name: "Chat als fertig markieren" })
          .isVisible(),
      ).toBe(true);
      expect(await boxes()).toEqual(before);
    } finally {
      await page.close();
    }
  });

  test("the running mark turns calmly, and stands still with reduced motion", async () => {
    for (const reducedMotion of [false, true]) {
      const page = await open(busy, 1280, { reducedMotion });
      try {
        const spin = await page
          .locator(".assistant-chat-sidebar-item", { hasText: "Rechnungen Oktober" })
          .locator(".assistant-chat-marker > i")
          .evaluate((glyph) => {
            const style = getComputedStyle(glyph);
            return { name: style.animationName, duration: style.animationDuration };
          });
        expect(spin).toEqual(reducedMotion ? { name: "none", duration: expect.any(String) } : { name: "spin", duration: "1.6s" });
      } finally {
        await page.close();
      }
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
      expect(await done.isVisible()).toBe(true);
      const after = await rows(page);
      expect(after.rows.map((row) => ({ x: row.x, y: row.y, height: row.height, labelX: row.label.x, labelY: row.label.y }))).toEqual(
        before.rows.map((row) => ({ x: row.x, y: row.y, height: row.height, labelX: row.label.x, labelY: row.label.y })),
      );
    } finally {
      await page.close();
    }
  });

  // Evidence for reviews: `ASSISTANT_SIDEBAR_SCREENSHOTS=<folder>` writes the list in every state, light mode.
  test.skipIf(!process.env.ASSISTANT_SIDEBAR_SCREENSHOTS).each([1440, 390])("screenshots of every chat state at %i px", async (width) => {
    const folder = process.env.ASSISTANT_SIDEBAR_SCREENSHOTS!;
    // The open chat runs, and a second one runs in the background.
    const shown = [...busy, conversation("import", "Kundenliste importieren", 0.03, { runStatus: "running" })];
    const page = await open(shown, width, { activeConversationId: "invoices" });
    try {
      await frames(page);
      const target = width > 1024 ? page.locator(".k2b-app-workspace__sidebar").first() : page.locator("#menu");
      await target.screenshot({ path: resolve(folder, `sidebar-${width}.png`), animations: "disabled" });
    } finally {
      await page.close();
    }
  });
});
