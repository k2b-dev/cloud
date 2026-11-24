import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { GroupRelations } from "@k2b/cloud/contracts";
import { appHostCss } from "../../ui/test/app-host-fixture";
import { launchBrowser, pageErrors } from "../../ui/test/browser";

const ui = resolve(import.meta.dir, "../../ui");
let browser: Awaited<ReturnType<typeof launchBrowser>>;
let bundle: string;
let css: string;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [all, tech, platform, oncall, sales] = [1, 2, 3, 4, 5].map(id) as [string, string, string, string, string];
const node = (nodeId: string, name: string, extra: Partial<GroupRelations["nodes"][number]> = {}) => ({
  id: nodeId,
  name,
  provider: "local" as const,
  members: 3,
  contains: 1,
  inCycle: false,
  ...extra,
});
const nodes = [
  node(all, "All staff", { contains: 2 }),
  node(tech, "Engineering", { provider: "ipa", inCycle: true }),
  node(platform, "Platform", { provider: "ipa", inCycle: true }),
  node(oncall, "On call", { provider: "ipa", inCycle: true }),
  node(sales, "Sales", { contains: 0 }),
];
const list = (ids: string[]) => ({ ids, total: ids.length });
// The relations around Engineering at depth 2: a cycle Engineering → Platform → On call → Engineering inside All staff.
const graph: GroupRelations = {
  focus: tech,
  depth: 2,
  managers: false,
  groupCount: 5,
  nodes,
  columns: [
    { key: "u1", items: [{ id: all, via: tech }], backs: [{ from: tech, to: oncall, closesCycle: true }], hidden: 0 },
    { key: "d1", items: [{ id: platform, via: tech }], backs: [], hidden: 3 },
    { key: "d2", items: [{ id: oncall, via: platform }], backs: [], hidden: 0 },
  ],
  roots: null,
  selected: {
    id: tech,
    parents: list([all, oncall]),
    children: list([platform]),
    manages: null,
    managedBy: null,
    cycle: { path: [tech, platform, oncall, tech], size: 3 },
    managerCycle: null,
  },
  cycles: { count: 1, first: tech },
  truncated: false,
  cyclesComplete: true,
  managerCyclesComplete: true,
};
const tree: GroupRelations = { ...graph, columns: [], roots: { ids: [all], hidden: 1 } };
const children: Record<string, string[]> = { [all]: [sales, tech], [tech]: [platform], [platform]: [oncall], [oncall]: [tech] };

beforeAll(async () => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../test/group-relations.browser-fixture.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "group-relations-dom",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            if (!result?.code) throw new Error(`Could not transform ${path}`);
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Group relations browser fixture failed");
  bundle = await build.outputs[0]!.text();
  css = await appHostCss(resolve(import.meta.dir, "../src/styles/app.css"));
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (
  width: number,
  dark: boolean,
  view: "graph" | "list",
  requests: string[] = [],
  relations: GroupRelations = view === "list" ? tree : graph,
  pages: string[] = [],
) => {
  const tab = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = pageErrors(tab);
  await tab.route("https://cloud.example.test/api/accounts/groups/relations**", (route) => {
    const url = new URL(route.request().url());
    requests.push(url.search);
    const focus = url.searchParams.get("focus") ?? tech;
    const selected = url.searchParams.get("selected");
    if (url.searchParams.get("expand") === "d1") {
      const ids = children[focus] ?? [];
      return route.fulfill({
        json: { ...graph, focus, columns: [{ key: "d1", items: ids.map((child) => ({ id: child, via: focus })), backs: [], hidden: 0 }] },
      });
    }
    return route.fulfill({
      json: {
        ...tree,
        roots: url.searchParams.get("expand") === "roots" ? { ids: [all, sales], hidden: 0 } : tree.roots,
        selected: { ...graph.selected!, id: selected ?? tech, cycle: selected === sales ? null : graph.selected!.cycle },
      },
    });
  });
  await tab.route("https://cloud.example.test/fixture.js", (route) =>
    route.fulfill({ contentType: "text/javascript; charset=utf-8", body: bundle }),
  );
  // Every page the view opens, with its query; a control's page change lands here too.
  await tab.route(
    (url) => url.pathname === "/app/accounts/groups/relations",
    (route) => {
      pages.push(new URL(route.request().url()).search);
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html lang="en" class="${dark ? "dark" : ""}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body class="k2b-ui" data-theme="${dark ? "dark" : "light"}"><main id="root" class="p-4"></main><script>window.relationsFixture=${JSON.stringify({ view, relations })}</script><script src="/fixture.js"></script></body></html>`,
      });
    },
  );
  await tab.goto("https://cloud.example.test/app/accounts/groups/relations");
  return { tab, errors };
};

for (const width of [390, 1440])
  for (const dark of [false, true])
    test(`relation levels ${width} ${dark ? "dark" : "light"}: every edge starts and ends at its card, no page scroll`, async () => {
      const { tab, errors } = await open(width, dark, "graph");
      try {
        await tab
          .getByRole("link", { name: /^Engineering/ })
          .first()
          .waitFor();
        expect(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await tab.getByRole("link", { name: "1 cycle" }).waitFor();
        await tab.getByRole("radiogroup", { name: "Depth" }).waitFor();
        // A back edge that closes the cycle is its own card, and the details walk one real cycle.
        await tab.getByRole("link", { name: "On call: contains Engineering, so it leads back" }).waitFor();
        await tab.getByText("Engineering → Platform → On call → Engineering", { exact: false }).waitFor();
        await tab.getByRole("link", { name: "+ 3 more" }).waitFor();
        const edges = await tab.evaluate(() => {
          const svg = document.querySelector("[data-stage] svg");
          if (!svg || getComputedStyle(svg).display === "none") return null;
          const origin = svg.getBoundingClientRect();
          const boxes = [...document.querySelectorAll("[data-stage] a")].map((link) => {
            const box = link.getBoundingClientRect();
            return { left: box.left - origin.left, right: box.right - origin.left, middle: box.top - origin.top + box.height / 2 };
          });
          return [...svg.querySelectorAll(":scope > path")].map((path) => {
            const numbers = (path.getAttribute("d") ?? "").match(/-?\d+(\.\d+)?/g)!.map(Number);
            const [x1, y1] = numbers;
            const [x2, y2] = numbers.slice(-2);
            const near = (x: number, y: number, side: "left" | "right") =>
              boxes.some((box) => Math.abs(box[side] - x) <= 1 && Math.abs(box.middle - y) <= 1);
            return near(x1!, y1!, "right") && near(x2!, y2!, "left");
          });
        });
        if (width === 390) expect(edges).toBeNull();
        else expect(edges).toEqual([true, true, true, true]);
        expect(errors).toEqual([]);
      } finally {
        await tab.close();
      }
    });

test("a back edge that closes a cycle arcs from its card to the group it leads back to", async () => {
  // Engineering at depth 3: On call contains Engineering again, three levels down.
  const cycle: GroupRelations = {
    ...graph,
    depth: 3,
    columns: [
      { key: "u1", items: [{ id: all, via: tech }], backs: [], hidden: 0 },
      { key: "d1", items: [{ id: platform, via: tech }], backs: [], hidden: 0 },
      { key: "d2", items: [{ id: oncall, via: platform }], backs: [], hidden: 0 },
      { key: "d3", items: [], backs: [{ from: oncall, to: tech, closesCycle: true }], hidden: 0 },
    ],
  };
  const { tab, errors } = await open(1440, false, "graph", [], cycle);
  try {
    const back = tab.getByRole("link", { name: "Engineering: On call contains it again" });
    await back.waitFor();
    const arc = await tab.evaluate(() => {
      const svg = document.querySelector("[data-stage] svg")!;
      const origin = svg.getBoundingClientRect();
      const box = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return { center: rect.left - origin.left + rect.width / 2, top: rect.top - origin.top };
      };
      const path = svg.querySelector(":scope > path[marker-end]");
      const numbers = (path?.getAttribute("d") ?? "").match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
      const links = [...document.querySelectorAll("[data-stage] a")];
      const start = box(links.find((link) => link.getAttribute("aria-label")?.startsWith("Engineering:"))!);
      const end = box(links.find((link) => link.getAttribute("aria-current") === null && link.textContent?.startsWith("Engineering"))!);
      return { numbers, start, end };
    });
    const [x1, y1] = arc.numbers;
    expect(Math.abs(x1! - arc.start.center)).toBeLessThanOrEqual(1);
    expect(Math.abs(y1! - arc.start.top)).toBeLessThanOrEqual(1);
    // The arc ends with "Q … x y V top": its last x is the third number from the end.
    expect(Math.abs(arc.numbers.at(-3)! - arc.end.center)).toBeLessThanOrEqual(1);
    expect(Math.abs(arc.numbers.at(-1)! - arc.end.top)).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  } finally {
    await tab.close();
  }
});

for (const [width, dark] of [
  [1440, false],
  [390, true],
] as const)
  test(`relation tree ${width} ${dark ? "dark" : "light"}: one tab stop, keys, Enter, cycles end, and controls keep the selection`, async () => {
    const requests: string[] = [];
    const pages: string[] = [];
    const { tab, errors } = await open(width, dark, "list", requests, tree, pages);
    const focused = () => tab.evaluate(() => document.activeElement?.textContent ?? "");
    try {
      const items = tab.getByRole("treeitem");
      await items.first().waitFor();
      expect(await tab.locator('[role="treeitem"][tabindex="0"]').count()).toBe(1);
      await items.first().focus();
      await tab.keyboard.press("ArrowRight");
      await tab.getByRole("treeitem", { name: /Engineering/ }).waitFor();
      expect(await items.first().getAttribute("aria-expanded")).toBe("true");
      await tab.keyboard.press("ArrowDown");
      await tab.keyboard.press("ArrowDown");
      await tab.keyboard.press("ArrowRight");
      await tab.getByRole("treeitem", { name: /Platform/ }).waitFor();
      await tab.keyboard.press("ArrowDown");
      await tab.keyboard.press("ArrowRight");
      await tab.getByRole("treeitem", { name: /On call/ }).waitFor();
      await tab.keyboard.press("ArrowDown");
      await tab.keyboard.press("ArrowRight");
      await tab.getByRole("treeitem", { name: "leads back to Engineering" }).waitFor();
      expect(await tab.locator('[role="treeitem"][tabindex="0"]').count()).toBe(1);
      expect(await tab.locator('[role="treeitem"][aria-level="2"]').first().getAttribute("aria-setsize")).toBe("2");
      await tab.keyboard.press("End");
      expect(await focused()).toContain("leads back to Engineering");
      // From a row without children, the left arrow goes to its parent.
      await tab.keyboard.press("ArrowLeft");
      expect(await focused()).toContain("On call");
      await tab.keyboard.press("Home");
      await tab.keyboard.press("ArrowDown");
      await tab.keyboard.press("Enter");
      await tab.getByRole("heading", { name: "Sales", level: 2 }).waitFor();
      expect(new URL(tab.url()).searchParams.get("sel")).toBe(sales);
      // The top groups carry a budget too; the rest opens in place.
      await tab.getByRole("button", { name: "+ 1 more" }).click();
      await tab.locator('[role="treeitem"][aria-level="1"]').nth(1).waitFor();
      expect(await tab.locator('[role="treeitem"][aria-level="1"]').count()).toBe(2);
      await tab.getByRole("button", { name: "+ 1 more" }).waitFor({ state: "detached" });
      expect(requests.at(-1)).toContain("expand=roots");
      expect(requests.some((search) => search.includes("selected=00000000-0000-4000-8000-000000000005"))).toBe(true);
      // A click keeps the keyboard on the row, also when the row closes.
      await tab.locator('[role="treeitem"][aria-level="1"]').first().click();
      expect(await focused()).toContain("All staff");
      await tab.getByRole("heading", { name: "All staff", level: 2 }).waitFor();
      // A control opens the next page from the URL as it is now, with the selection made in the tree.
      await tab.getByRole("link", { name: "Managers" }).click();
      await tab.waitForFunction(() => location.search.includes("managers=1"));
      const params = new URLSearchParams(pages.at(-1));
      expect(params.get("sel")).toBe(all);
      expect(params.get("managers")).toBe("1");
      expect(errors).toEqual([]);
    } finally {
      await tab.close();
    }
  });
