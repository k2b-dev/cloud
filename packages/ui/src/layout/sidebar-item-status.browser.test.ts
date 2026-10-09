import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

// Row height and mark widths are results of layout with the real type, which
// happy-dom does not model, so a real engine runs the shipped browser build.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const assets = "http://k2b-ui.test/";
const fonts = ["plex.css", "tabler.css"]
  .map((file) => readFileSync(resolve(ui, "dist", file), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`))
  .join("\n");

// Every state a row can show, once as a plain row and once with a second line.
const states = {
  plain: null,
  one: { unread: 1 },
  many: { unread: 1234 },
  dot: { unread: true },
  mention: { unread: 3, mention: true },
  mutedDot: { unread: true, muted: true },
  all: { unread: 120, mention: true, muted: true },
  mutedOnly: { muted: true },
};

const entry = resolve(import.meta.dir, "sidebar-item-status.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { AppWorkspace } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const states = ${JSON.stringify(states)};
const row = (name, status, description) =>
  createComponent(AppWorkspace.SidebarItem, {
    href: "#" + name,
    icon: "ti ti-hash",
    description,
    data: { state: name, lines: description ? 2 : 1 },
    get meta() {
      return status ? createComponent(AppWorkspace.SidebarItemStatus, status) : undefined;
    },
    get children() {
      return createComponent(AppWorkspace.SidebarItemLabel, { children: "Design reviews" });
    },
  });

render(
  () =>
    createComponent(AppWorkspace, {
      resizable: false,
      get children() {
        return [
          createComponent(AppWorkspace.Sidebar, {
            get children() {
              return createComponent(AppWorkspace.SidebarDesktop, {
                get children() {
                  return createComponent(AppWorkspace.SidebarBody, {
                    get children() {
                      return createComponent(AppWorkspace.SidebarSection, {
                        title: "Chats",
                        get children() {
                          return Object.entries(states).flatMap(([name, status]) => [
                            row(name, status),
                            row(name, status, "Mara: The new header looks calm"),
                          ]);
                        },
                      });
                    },
                  });
                },
              });
            },
          }),
          createComponent(AppWorkspace.Content, {
            get children() {
              return createComponent(AppWorkspace.Main, { children: "Conversation" });
            },
          }),
        ];
      },
    }),
  document.getElementById("app"),
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the sidebar status fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (theme: "light" | "dark"): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route(`${assets}**`, (route) =>
    route.fulfill({ path: resolve(ui, "dist", new URL(route.request().url()).pathname.slice(1)) }),
  );
  await page.setContent(
    `<!doctype html><html lang="en"><head><style>${css}</style><style>${fonts}</style>` +
      "<style>*,*::before,*::after{transition:none!important;animation:none!important}</style></head>" +
      `<body class="k2b-ui${theme === "dark" ? " k2b-dark" : ""}" style="margin:0"><div id="app" style="height:56rem"></div></body></html>`,
  );
  // A face that arrives late changes text sizes, which is not the row's doing.
  await page.evaluate(() =>
    Promise.all(
      ["400 12px 'IBM Plex Sans'", "600 12px 'IBM Plex Sans'", "700 12px 'IBM Plex Sans'", "16px tabler-icons"].map((font) =>
        document.fonts.load(font),
      ),
    ),
  );
  await page.addScriptTag({ content: script });
  await page.locator('[data-state="all"][data-lines="2"]').waitFor();
  return page;
};

type Measured = {
  state: string;
  lines: string;
  height: number;
  labelStart: number;
  labelWeight: string;
  unreadWidth: number | null;
  countWidth: number | null;
  markCenter: number | null;
  rowEnd: number;
  marks: { width: number; height: number }[];
};

const measure = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".k2b-app-workspace__sidebar-item[data-state]")).map((row): Measured => {
      const box = (selector: string) => row.querySelector(selector)?.getBoundingClientRect() ?? null;
      const label = row.querySelector(".k2b-app-workspace__sidebar-item-label")!;
      const unread = box(".k2b-app-workspace__sidebar-status-unread");
      const mark = box(".k2b-app-workspace__sidebar-status-count") ?? box(".k2b-app-workspace__sidebar-status-dot");
      return {
        state: row.dataset.state!,
        lines: row.dataset.lines!,
        height: row.getBoundingClientRect().height,
        labelStart: label.getBoundingClientRect().left,
        labelWeight: getComputedStyle(label).fontWeight,
        unreadWidth: unread?.width ?? null,
        countWidth: box(".k2b-app-workspace__sidebar-status-count")?.width ?? null,
        markCenter: mark ? mark.right - mark.width / 2 - (unread?.right ?? 0) : null,
        rowEnd: row.getBoundingClientRect().right,
        marks: Array.from(row.querySelectorAll(".k2b-app-workspace__sidebar-status > *:not(.k2b-sr-only)")).map((element) => {
          const rect = element.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        }),
      };
    }),
  );

describe("@k2b/ui sidebar item status", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`${theme}: every state keeps the row height, the label start, and fixed mark widths`, async () => {
      const page = await load(theme);
      try {
        const rows = await measure(page);
        expect(rows).toHaveLength(Object.keys(states).length * 2);
        for (const lines of ["1", "2"]) {
          const group = rows.filter((row) => row.lines === lines);
          const plain = group.find((row) => row.state === "plain")!;
          for (const row of group) {
            expect({ state: row.state, height: row.height, labelStart: row.labelStart }).toEqual({
              state: row.state,
              height: plain.height,
              labelStart: plain.labelStart,
            });
            for (const mark of row.marks) expect(mark.height).toBeLessThanOrEqual(16);
          }
        }

        // A count and a dot share one slot of one width; the dot sits where a one-digit count would.
        const slots = rows.filter((row) => row.unreadWidth !== null);
        expect(new Set(slots.map((row) => row.unreadWidth)).size).toBe(1);
        for (const row of slots) expect(row.countWidth ?? 0).toBeLessThanOrEqual(row.unreadWidth!);
        const one = rows.find((row) => row.state === "one")!;
        const dot = rows.find((row) => row.state === "dot")!;
        expect(dot.markCenter).toBeCloseTo(one.markCenter!, 1);

        // Unread is weight and count, not color alone; a quiet dot keeps the regular weight.
        for (const row of rows) {
          const counted = ["one", "many", "mention", "all"].includes(row.state);
          expect({ state: row.state, weight: row.labelWeight }).toEqual({ state: row.state, weight: counted ? "600" : "400" });
        }
      } finally {
        await page.close();
      }
    }, 30_000);
  }

  test("hover changes no box in any state", async () => {
    const page = await load("light");
    try {
      const rest = await measure(page);
      for (const state of Object.keys(states)) {
        const row = page.locator(`[data-state="${state}"][data-lines="1"]`);
        await row.hover();
        expect(await measure(page)).toEqual(rest);
      }
    } finally {
      await page.close();
    }
  }, 30_000);
});
