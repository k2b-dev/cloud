import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { layoutProblems } from "@k2b/ui/layout-check";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../../../../ui/test/browser";
import type { NotebookPageHarness } from "./notebook-page.browser-harness";
import type { NotebookContext } from "./sidebar/types";

// Each fixture types its browser window locally; other harnesses use the same property.
declare const window: { harness: NotebookPageHarness };

/**
 * A note page of Cloud flach (K6, K11, K15, "one line, one owner", "a scrollbar moves nothing"): the note has neither
 * head nor status row, its views and actions float in pills, the text stands at a 720 px measure with 18 and 16 px
 * headings, and nothing overlaps, spills, is cut, or draws a second line, with few and with many lines.
 */
const at = "2026-01-01T00:00:00.000Z";
const row = (id: string, title: string, parentId: string | null = null, hasChildren = false) => ({
  id,
  parentId,
  title,
  position: 0,
  hasChildren,
  createdAt: at,
  updatedAt: at,
  lockedAt: null,
});
const ctx: NotebookContext = {
  notebook: {
    id: "Book01",
    name: "Handbuch",
    description: null,
    icon: null,
    homepageNoteId: "Home01",
    defaultPresentationMode: "write",
    defaultNoteTitleTemplate: "",
    noteDeletePermission: "write",
    createdBy: null,
    createdAt: at,
    updatedAt: at,
  },
  sidebarTree: {
    total: 8,
    expandedIds: ["Werk01"],
    levels: [
      {
        parentId: null,
        total: 4,
        offset: 0,
        items: [
          row("Home01", "Startseite"),
          row("Werk01", "Werkstatt", null, true),
          row("Buro01", "Büro"),
          row("Neu001", "Neu im Betrieb"),
        ],
      },
      {
        parentId: "Werk01",
        total: 4,
        offset: 0,
        items: [
          row("Note01", "Sicherheitsunterweisung", "Werk01"),
          row("Masc01", "Maschinen einweisen", "Werk01"),
          row("Rein01", "Reinigungsplan", "Werk01"),
          row("Lack01", "Lacke und Öle lagern", "Werk01"),
        ],
      },
    ],
  },
  sidebarList: null,
  selectedNoteId: "Note01",
  userId: "00000000-0000-4000-8000-000000000001",
  settings: { lastNoteId: null, richMode: "rich", treeSort: "title" },
  navigationHidden: false,
  fullWidth: false,
  permission: "write",
  attachmentCount: 14,
  favoriteNoteIds: [],
  tags: [{ tag: "sicherheit", count: 3 }],
  pageTemplates: [],
  workspaceCursor: null,
  dateConfig: { locale: "de", timeZone: "Europe/Berlin" },
  sidebarFilter: {},
};

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const ui = `${resolve(import.meta.dir, "../../../../../ui")}/`;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "notebook-page.browser-harness.tsx")],
    target: "browser",
    conditions: ["browser"],
    // The Detail's PDF dialog includes MapLibre's import.meta worker URLs.
    format: "esm",
    plugins: [
      {
        name: "solid-notebook-page-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the note page harness.");
  const bundle = await build.outputs[0]!.text();
  // The shipped page-head order and cascade.
  const outputs = await Promise.all(
    [resolve(import.meta.dir, "../../../styles/app.css"), resolve(import.meta.dir, "../../../../../../styles.css")].map(async (entry) => {
      const css = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
      if (!css.success) throw new AggregateError(css.logs, `Could not compile ${entry}.`);
      return css.outputs[0]!.text();
    }),
  );
  const css = ["@layer properties, theme, base, components, utilities;", ...outputs].join("\n");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/notebooks/overview/activity") return Response.json({ data: [], nextCursor: null });
      if (path === "/api/notebooks/Book01/access/members") return Response.json([]);
      if (/^\/(fonts\/)?[a-zA-Z0-9._-]+\.(woff2|css)$/.test(path)) return new Response(Bun.file(resolve(ui, "dist", path.slice(1))));
      if (path.startsWith("/api/")) return new Response("Unexpected harness API", { status: 404 });
      if (path === "/harness.js") return new Response(bundle, { headers: { "content-type": "application/javascript; charset=utf-8" } });
      return new Response(
        `<!doctype html><html lang="de" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/plex.css"><link rel="stylesheet" href="/tabler.css"><style>${css}</style></head><body class="k2b-ui" style="margin:0"><div id="root" style="height:100dvh;display:flex;flex-direction:column"></div><script type="module" src="/harness.js"></script></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

/**
 * The layout self-check of the page, in two parts as the check's own limits ask. The note's frame is left out of the
 * page check, because its row of pills floats over the text on purpose (K16; their touch hit areas reach past the
 * pills). The text inside the frame is checked on its own, with 8 px of slack: a table in the text reaches 8 px into
 * the scroller's inline padding, so its lines run past the text as in the Book (`@k2b/editor` theme).
 */
const problems = async (page: Page, slack?: number) => [
  ...(await page.evaluate(layoutProblems, { root: "#root", ignore: ".k2b-avatar-stack, .notebook-editor-frame", slack })).problems,
  ...(await page.evaluate(layoutProblems, { root: ".notebook-editor-frame > .k2b-scroll-area", slack: 8 })).problems,
];

type Open = { width: number; mode?: "write" | "read"; content?: "few" | "many"; detail?: boolean; overview?: boolean; locked?: boolean };
const open = async ({ width, mode = "write", content = "few", detail = false, overview = false, locked = false }: Open): Promise<Page> => {
  const phone = width < 768;
  const page = await browser.newPage({ viewport: { width, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone });
  await page.goto(
    `${server.url}?mode=${mode}&content=${content}${detail ? "&detail=1" : ""}${overview ? "&page=overview" : ""}${locked ? "&locked=1" : ""}`,
  );
  await page.waitForFunction(() => "harness" in window);
  await page.evaluate((value) => window.harness.mount(value), ctx);
  await page.locator(overview ? ".notebooks-overview-main" : ".cm-content").waitFor();
  await page.evaluate(() => window.harness.settle());
  const name = overview ? `overview-${content}` : `${mode}-${content}${detail ? "-detail" : ""}`;
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/notebooks-${name}-${width}.png` });
  return page;
};

// Each page loads the note page's bundle (CodeMirror and the Detail's MapLibre), as the Detail panel's test does.
describe("a note is a reading column without head", () => {
  for (const width of [1440, 390])
    for (const content of ["few", "many"] as const)
      test(`${width} px, ${content} lines: nothing overlaps, spills, is cut, or draws a second line`, async () => {
        const page = await open({ width, content });
        try {
          expect(await problems(page)).toEqual([]);
        } finally {
          await page.close();
        }
      }, 30_000);

  for (const width of [1440, 390])
    test(`${width} px, Read: the page pill holds the way into Write and the Details`, async () => {
      const page = await open({ width, mode: "read" });
      try {
        const pill = page.getByRole("group", { name: "Aktionen für die Notiz" });
        expect(await pill.getByRole("link", { name: "Notiz bearbeiten" }).count()).toBe(1);
        expect(await pill.locator("[data-app-workspace-detail-toggle]").count()).toBe(1);
        expect(await problems(page)).toEqual([]);
      } finally {
        await page.close();
      }
    }, 30_000);

  test("Read of a locked note offers no way into Write, and keeps navigation and Details", async () => {
    const page = await open({ width: 1440, mode: "read", locked: true });
    try {
      const pill = page.getByRole("group", { name: "Aktionen für die Notiz" });
      expect(await pill.getByRole("link", { name: "Notiz bearbeiten" }).count()).toBe(0);
      expect(await pill.locator("[data-app-workspace-detail-toggle]").count()).toBe(1);
      expect(await pill.locator("[data-app-workspace-sidebar-toggle]").count()).toBe(1);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("1440 px with the Detail open: the columns meet on one line and nothing overlaps", async () => {
    const page = await open({ width: 1440, content: "many", detail: true });
    try {
      await page.locator(".notebook-detail-panel").waitFor();
      expect(await problems(page)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("the text stands at a 720 px measure, 14 px on 22 px, with 18 and 16 px headings (K11)", async () => {
    const page = await open({ width: 1440 });
    try {
      const type = await page.evaluate(() => {
        const content = document.querySelector<HTMLElement>(".cm-content")!;
        const line = (text: string) =>
          Array.from(document.querySelectorAll<HTMLElement>(".cm-line")).find((element) => element.textContent?.startsWith(text))!;
        const size = (element: Element) => {
          const leaf = Array.from(element.querySelectorAll<HTMLElement>("span")).find((span) => span.textContent?.trim()) ?? element;
          return getComputedStyle(leaf).fontSize;
        };
        const body = getComputedStyle(line("Jede neue Person"));
        return {
          width: content.getBoundingClientRect().width,
          body: `${body.fontSize}/${body.lineHeight}`,
          h1: size(line("Sicherheitsunterweisung")),
          h2: size(line("Vor dem ersten Arbeitstag")),
        };
      });
      expect(type).toEqual({ width: 720, body: "14px/22px", h1: "18px", h2: "16px" });
    } finally {
      await page.close();
    }
  }, 30_000);
});

describe("the overview is one head and one flat list", () => {
  for (const width of [1440, 390])
    for (const content of ["few", "many"] as const)
      test(`${width} px, ${content} notes: nothing overlaps, spills, is cut, or draws a second line`, async () => {
        const page = await open({ width, content, overview: true });
        try {
          expect((await page.evaluate(layoutProblems, { root: "#root" })).problems).toEqual([]);
          // K1: a row with a second text line is 52 px, on a phone 60 px.
          const heights = await page
            .locator(".notebooks-overview-note")
            .evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
          expect(new Set(heights)).toEqual(new Set([width < 768 ? 60 : 52]));
        } finally {
          await page.close();
        }
      }, 30_000);
});
