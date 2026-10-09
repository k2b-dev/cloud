import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

// Row height and mark widths are results of layout with the real type, which
// happy-dom does not model, so a real engine runs the shipped browser build.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const assets = "http://k2b-ui.test/";
const fonts = ["plex.css", "tabler.css"]
  .map((file) => readFileSync(resolve(ui, "dist", file), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`))
  .join("\n");

// Every state a row can show. `empty` is a status with nothing to show.
const states = {
  plain: null,
  empty: { unread: 0 },
  one: { unread: 1 },
  many: { unread: 1234 },
  dot: { unread: true },
  mention: { unread: 3, mention: true },
  mentionOnly: { mention: true },
  mutedDot: { unread: true, muted: true },
  all: { unread: 120, mention: true, muted: true },
  mutedOnly: { muted: true },
};
const counted = new Set(["one", "many", "mention", "all"]);
// Each row variant and container, with the states it is checked in.
const groups = {
  flat: Object.keys(states),
  lines: Object.keys(states),
  card: ["plain", "one", "mention"],
  object: ["plain", "one"],
  action: ["plain", "one", "all"],
  tree: ["plain", "one", "all"],
};
// The label weight a group shows for read and for counted rows.
const weights: Record<keyof typeof groups, [string, string]> = {
  flat: ["400", "600"],
  lines: ["400", "600"],
  card: ["500", "600"],
  object: ["600", "700"],
  action: ["400", "600"],
  tree: ["400", "600"],
};

const entry = resolve(import.meta.dir, "sidebar-item-status.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { AppWorkspace } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const states = ${JSON.stringify(states)};
const groups = ${JSON.stringify(groups)};
const status = (value) => (value ? createComponent(AppWorkspace.SidebarItemStatus, value) : undefined);
const label = (children = "Design reviews") => createComponent(AppWorkspace.SidebarItemLabel, { children });
const extras = {
  flat: {},
  lines: { description: "Mara: The new header looks calm" },
  card: { variant: "card", context: "Mara", contextMeta: "09:41", description: "The new header looks calm" },
  object: { variant: "object", description: "design@example.test" },
  action: {},
};
const row = (group, name, extra = extras[group]) =>
  createComponent(AppWorkspace.SidebarItem, {
    href: "#" + group + "-" + name,
    icon: "ti ti-hash",
    data: { group, state: name },
    ...extra,
    get meta() {
      return status(states[name]);
    },
    get children() {
      return group === "action"
        ? [label(), createComponent(AppWorkspace.SidebarItemAction, { icon: "ti ti-settings", label: "Settings", visibility: "hover" })]
        : label();
    },
  });

// One status whose props change, as an application passes a live count.
const [live, setLive] = createSignal({});
window.setLiveStatus = setLive;

const sections = () => [
  ...["flat", "lines", "card", "object", "action"].map((group) =>
    createComponent(AppWorkspace.SidebarSection, {
      title: group,
      get children() {
        return groups[group].map((name) => row(group, name));
      },
    }),
  ),
  createComponent(AppWorkspace.SidebarSection, {
    title: "tree",
    get children() {
      return createComponent(AppWorkspace.NavTree, {
        ariaLabel: "Channels",
        get children() {
          return groups.tree.map((name) =>
            createComponent(AppWorkspace.NavTree.Item, {
              id: name,
              href: "#tree-" + name,
              icon: "ti ti-hash",
              label: "Design reviews",
              class: "status-tree-" + name,
              get meta() {
                return status(states[name]);
              },
            }),
          );
        },
      });
    },
  }),
  createComponent(AppWorkspace.SidebarSection, {
    title: "previews",
    get children() {
      return [
        // A read row whose preview lists rows of its own, one of them unread.
        createComponent(AppWorkspace.SidebarItem, {
          href: "#projects",
          icon: "ti ti-folders",
          data: { group: "preview", state: "parent" },
          preview: {
            label: "Projects",
            get content() {
              return [row("child", "one", {}), row("child", "plain", {})];
            },
          },
          get children() {
            return label("Projects");
          },
        }),
        ...["mention", "plain"].map((name) =>
          createComponent(AppWorkspace.SidebarItem, {
            icon: "ti ti-hash",
            data: { group: "row-preview", state: name },
            preview: { label: "Design reviews", trigger: "row", content: "Latest messages" },
            get meta() {
              return status(states[name]);
            },
            get children() {
              return label();
            },
          }),
        ),
        createComponent(AppWorkspace.SidebarItem, {
          href: "#live",
          icon: "ti ti-hash",
          data: { group: "live", state: "live" },
          get meta() {
            return createComponent(AppWorkspace.SidebarItemStatus, {
              get unread() {
                return live().unread;
              },
              get mention() {
                return live().mention;
              },
              get muted() {
                return live().muted;
              },
            });
          },
          get children() {
            return label();
          },
        }),
      ];
    },
  }),
];

render(
  () =>
    createComponent(AppWorkspace, {
      resizable: false,
      get children() {
        return [
          createComponent(AppWorkspace.Sidebar, {
            mobile: "stacked",
            get children() {
              return createComponent(AppWorkspace.SidebarDesktop, {
                get children() {
                  return createComponent(AppWorkspace.SidebarBody, {
                    get children() {
                      return sections();
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

const viewports = {
  desktop: { viewport: { width: 1280, height: 900 } },
  // A stacked sidebar keeps the rows on a phone, where hover actions stay visible.
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
} satisfies Record<string, BrowserContextOptions>;

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (theme: "light" | "dark", viewport: keyof typeof viewports = "desktop"): Promise<Page> => {
  const page = await browser.newPage(viewports[viewport]);
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
      [
        "400 12px 'IBM Plex Sans'",
        "500 12px 'IBM Plex Sans'",
        "600 12px 'IBM Plex Sans'",
        "700 12px 'IBM Plex Sans'",
        "16px tabler-icons",
      ].map((font) => document.fonts.load(font)),
    ),
  );
  await page.addScriptTag({ content: script });
  await page.locator('[data-group="live"]').waitFor();
  return page;
};

type Box = { left: number; right: number; width: number; height: number };
type Measured = {
  group: string;
  state: string;
  height: number;
  labelStart: number;
  labelWidth: number;
  labelWeight: string;
  hasMeta: boolean;
  unread: Box | null;
  count: Box | null;
  dot: Box | null;
  mention: Box | null;
  muted: Box | null;
  rowEnd: number;
  marks: Box[];
};

const measure = (page: Page) =>
  page.evaluate(() => {
    // Layout works in 1/64 px; snapping to it drops float noise that WebKit
    // reports at a device scale of 3, such as 31.999998 for 32.
    const px = (value: number) => Math.round(value * 64) / 64;
    const rect = (element: Element | null): Box | null => {
      if (!element) return null;
      const { left, right, width, height } = element.getBoundingClientRect();
      return { left: px(left), right: px(right), width: px(width), height: px(height) };
    };
    const rows = [
      ...Array.from(document.querySelectorAll<HTMLElement>(".k2b-app-workspace__sidebar-item[data-state]")).map((row) => ({
        row,
        group: row.dataset.group!,
        state: row.dataset.state!,
      })),
      ...Array.from(document.querySelectorAll<HTMLElement>(".k2b-app-workspace__nav-tree-row")).map((row) => ({
        row,
        group: "tree",
        state: /status-tree-(\w+)/.exec(row.className)![1]!,
      })),
    ];
    return rows.map(({ row, group, state }): Measured => {
      const own = (selector: string) => row.querySelector(selector);
      const label = own(".k2b-app-workspace__sidebar-item-label")!;
      return {
        group,
        state,
        height: rect(row)!.height,
        labelStart: rect(label)!.left,
        labelWidth: rect(label)!.width,
        labelWeight: getComputedStyle(own(".k2b-app-workspace__sidebar-item-label-text")!).fontWeight,
        hasMeta: own(".k2b-app-workspace__sidebar-item-meta") !== null,
        unread: rect(own(".k2b-app-workspace__sidebar-status-unread")),
        count: rect(own(".k2b-app-workspace__sidebar-status-count")),
        dot: rect(own(".k2b-app-workspace__sidebar-status-dot")),
        mention: rect(own(".k2b-app-workspace__sidebar-status-mention")),
        muted: rect(own(".k2b-app-workspace__sidebar-status-muted")),
        rowEnd: rect(row)!.right,
        marks: Array.from(row.querySelectorAll(".k2b-app-workspace__sidebar-status > *:not(.k2b-sr-only)")).map(
          (element) => rect(element)!,
        ),
      };
    });
  });

const center = (box: Box) => box.left + box.width / 2;

const expectStableRows = (rows: Measured[]) => {
  for (const group of Object.keys(groups)) {
    const members = rows.filter((row) => row.group === group);
    expect(members.map((row) => row.state)).toEqual(groups[group as keyof typeof groups]);
    const plain = members.find((row) => row.state === "plain")!;
    for (const row of members) {
      expect({ group, state: row.state, height: row.height, labelStart: row.labelStart }).toEqual({
        group,
        state: row.state,
        height: plain.height,
        labelStart: plain.labelStart,
      });
      for (const mark of row.marks) expect(mark.height).toBeLessThanOrEqual(16);
    }
  }
};

describe("@k2b/ui sidebar item status", () => {
  for (const [theme, viewport] of [
    ["light", "desktop"],
    ["dark", "desktop"],
    ["light", "phone"],
  ] as const) {
    test(`${theme} ${viewport}: every state keeps the row height, the label start, and fixed mark places`, async () => {
      const page = await load(theme, viewport);
      try {
        const rows = await measure(page);
        expectStableRows(rows);

        // Every status reserves one unread slot of one width, which a count
        // fits, in one place per row variant.
        const slots = rows.filter((row) => row.group in groups && row.unread !== null);
        expect(new Set(slots.map((row) => row.unread!.width)).size).toBe(1);
        for (const row of slots) expect(row.count?.width ?? 0).toBeLessThanOrEqual(row.unread!.width);
        for (const group of Object.keys(groups)) {
          const ends = slots.filter((row) => row.group === group).map((row) => Math.round((row.rowEnd - row.unread!.right) * 10));
          expect({ group, ends: new Set(ends).size }).toEqual({ group, ends: 1 });
        }
        // The dot sits where a one-digit count would; bell and "@" line up across rows.
        const flat = (state: string) => rows.find((row) => row.group === "flat" && row.state === state)!;
        expect(center(flat("dot").dot!)).toBeCloseTo(center(flat("one").count!), 1);
        expect(flat("mutedDot").muted!.right).toBeCloseTo(flat("mutedOnly").muted!.right, 1);
        expect(flat("mutedDot").muted!.right).toBeCloseTo(flat("all").muted!.right, 1);
        expect(flat("mention").mention!.right).toBeCloseTo(flat("mentionOnly").mention!.right, 1);

        // A status with nothing to show leaves no slot, as on the server.
        expect(flat("empty").hasMeta).toBe(false);
        expect(flat("empty").labelWidth).toBeCloseTo(flat("plain").labelWidth, 1);

        // Unread is weight and count, not color alone; a quiet dot keeps the regular weight.
        for (const row of rows.filter((row) => row.group in weights)) {
          const [read, unread] = weights[row.group as keyof typeof groups];
          expect({ group: row.group, state: row.state, weight: row.labelWeight }).toEqual({
            group: row.group,
            state: row.state,
            weight: counted.has(row.state) ? unread : read,
          });
        }
      } finally {
        await page.close();
      }
    }, 30_000);
  }

  test("an unread row inside a preview leaves the rows around it read", async () => {
    const page = await load("light");
    try {
      const rows = await measure(page);
      const weight = (group: string, state: string) => rows.find((row) => row.group === group && row.state === state)?.labelWeight;
      expect([weight("preview", "parent"), weight("child", "one"), weight("child", "plain")]).toEqual(["400", "600", "400"]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("a row that opens a preview keeps its status as its description", async () => {
    const page = await load("light");
    try {
      const names = await page.evaluate(() =>
        ["mention", "plain"].map((state) => {
          const main = document.querySelector<HTMLElement>(
            `[data-group="row-preview"][data-state="${state}"] > .k2b-app-workspace__sidebar-item-main`,
          )!;
          const describedBy = main.getAttribute("aria-describedby");
          return {
            name: main.getAttribute("aria-label"),
            description: describedBy ? document.getElementById(describedBy)?.querySelector(".k2b-sr-only")?.textContent : null,
          };
        }),
      );
      expect(names).toEqual([
        { name: "Design reviews", description: ", 3 unread, mentions you" },
        { name: "Design reviews", description: null },
      ]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("new activity, a mention, or reading moves no other mark", async () => {
    const page = await load("light");
    try {
      const sequences = [
        [
          { muted: true },
          { muted: true, unread: true },
          { muted: true, unread: true, mention: true },
          { muted: true, unread: 4, mention: true },
          { muted: true, unread: 120 },
          { muted: true },
        ],
        [{ unread: 2 }, { unread: 2, mention: true }, { mention: true }, { unread: true, mention: true }, { unread: 0, mention: true }],
      ];
      const places: Record<"unread" | "mention" | "muted", Set<number>> = { unread: new Set(), mention: new Set(), muted: new Set() };
      for (const [index, sequence] of sequences.entries()) {
        const mention = new Set<number>();
        for (const status of sequence) {
          await page.evaluate((value) => (window as unknown as { setLiveStatus: (status: object) => void }).setLiveStatus(value), status);
          const live = (await measure(page)).find((row) => row.group === "live")!;
          expect(live.unread).not.toBeNull();
          places.unread.add(Math.round(live.unread!.right * 10));
          if (live.muted) places.muted.add(Math.round(live.muted.right * 10));
          if (live.mention) mention.add(Math.round(live.mention.right * 10));
        }
        expect({ sequence: index, mention: mention.size }).toEqual({ sequence: index, mention: 1 });
      }
      expect({ unread: places.unread.size, muted: places.muted.size }).toEqual({ unread: 1, muted: 1 });
    } finally {
      await page.close();
    }
  }, 30_000);

  test("hover changes no box in any state", async () => {
    const page = await load("light");
    try {
      const rest = await measure(page);
      for (const group of ["flat", "action"] as const) {
        for (const state of groups[group]) {
          await page.locator(`[data-group="${group}"][data-state="${state}"]`).hover();
          expect(await measure(page)).toEqual(rest);
        }
      }
    } finally {
      await page.close();
    }
  }, 30_000);
});
