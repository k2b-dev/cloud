import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { charts } from "@k2b/stdlib";
import { rule } from "./chart-rendering";

const findings = async (files: Record<string, string>, packages = ["demo", "ui", "cloud", "ssr"]) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-chart-rendering-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ workspaces: { packages: packages.map((id) => `packages/${id}`) } }));
    for (const [file, source] of Object.entries(files)) {
      const path = join(root, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, source);
    }
    const found = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    for (const finding of found) {
      expect(finding.message).toMatch(/Raw stdlib chart renderer|charts need an island for tooltips and keyboard inspection/);
    }
    return found.map((finding) => `${relative(root, finding.file ?? "")}:${finding.line}`).sort();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test.each([
  ["named renderer", "import { bar } from '@k2b/stdlib';", 1],
  ["aliased renderer", "import { line as drawLine } from '@k2b/stdlib';", 1],
  ["multi-line import", "import {\n  dates,\n  bar,\n} from '@k2b/stdlib';", 3],
  ["charts namespace", "import { charts } from '@k2b/stdlib';", 1],
  ["namespace property", "import * as s from '@k2b/stdlib';\ns.charts.line({});", 2],
  ["namespace renderer", "import * as s from '@k2b/stdlib';\ns.bar({});", 2],
  ["namespace element", "import * as s from '@k2b/stdlib';\ns['charts'].line({});", 2],
  ["namespace destructuring", "import * as s from '@k2b/stdlib';\nconst { charts: draw } = s;", 2],
  ["named re-export", "export { bar as drawBar } from '@k2b/stdlib';", 1],
  ["star re-export", "export * from '@k2b/stdlib';", 1],
  ["namespace re-export", "export * as x from '@k2b/stdlib';", 1],
  ["dynamic destructuring", "const { line } = await import('@k2b/stdlib');", 1],
  ["dynamic then destructuring", "import('@k2b/stdlib').then(({ bar }) => bar({}));", 1],
  ["dynamic then function", "import('@k2b/stdlib').then(function ({ charts: draw }) {});", 1],
  ["dynamic property", "(await import('@k2b/stdlib')).charts.bar({});", 1],
  ["dynamic element", "(await import('@k2b/stdlib'))['bar']({});", 1],
  ["bound dynamic namespace", "const s = await import('@k2b/stdlib');\ns.bar({});", 2],
  ["bound dynamic destructuring", "const s = await import('@k2b/stdlib');\nconst { line } = s;", 2],
  ["runtime renderer inventory", `import { ${Object.keys(charts).at(-1)} } from '@k2b/stdlib';`, 1],
] as const)("reports raw stdlib charts: %s", async (_name, source, line) => {
  expect(await findings({ "packages/demo/src/plot.ts": source })).toEqual([`packages/demo/src/plot.ts:${line}`]);
});

test("reports each offending named import or access once", async () => {
  expect(
    await findings({
      "packages/demo/src/plot.ts": "import { bar, line } from '@k2b/stdlib';\nimport * as s from '@k2b/stdlib';\ns.charts.line({});",
    }),
  ).toEqual(["packages/demo/src/plot.ts:1", "packages/demo/src/plot.ts:1", "packages/demo/src/plot.ts:3"]);
});

test.each([
  "import type { charts } from '@k2b/stdlib';",
  "import { type charts, dates, computeDomain, type DateContext } from '@k2b/stdlib';",
  "type Context = import('@k2b/stdlib').DateContext;",
  "import type * as s from '@k2b/stdlib'; type Context = s.charts;",
  "export type { charts } from '@k2b/stdlib';",
  "export { type bar, dates } from '@k2b/stdlib';",
  "export type * from '@k2b/stdlib';",
  "import * as s from '@k2b/stdlib'; s.dates;",
  "const { dates } = await import('@k2b/stdlib');",
  "import { charts, bar } from '@k2b/stdlib/browser';",
  "import * as s from '@k2b/stdlib/browser'; s.charts;",
  "(await import('@k2b/stdlib/browser')).charts;",
])("accepts non-chart or type-only stdlib use: %s", async (source) => {
  expect(await findings({ "packages/demo/src/plot.ts": source })).toEqual([]);
});

test.each([
  "packages/ui/src/content/Chart.tsx",
  "packages/assistant/src/artifacts/runtime/lib.ts",
  "packages/cloud/src/ai/chart-block.ts",
  "packages/demo/src/plot.test.ts",
  "packages/demo/src/plot.spec.tsx",
  "packages/demo/src/plot.browser-harness.tsx",
  "packages/demo/src/plot.browser-fixture.ts",
  "packages/demo/src/plot.browser-suite.tsx",
  "packages/demo/fixture/plot.tsx",
  "packages/demo/scripts/plot.ts",
  "docs-site/scripts/plot.ts",
])("skips raw renderers in %s", async (path) => {
  expect(await findings({ [path]: "import { charts } from '@k2b/stdlib';" })).toEqual([]);
});

test.each(["packages/unlisted/src/plot.ts", "docs-site/src/plot.tsx", "packages/ui/src/content/Other.tsx"])(
  "guards raw renderers in %s",
  async (path) => {
    expect(await findings({ [path]: "import { bar } from '@k2b/stdlib';" })).toEqual([`${path}:1`]);
  },
);

const panel = "import { Chart } from '@k2b/ui';\nexport const Panel = () => <Chart kind='bar' data={[]} />;";
const panelPath = "packages/demo/src/frontend/Panel.tsx";
const panelFinding = `${panelPath}:2`;

test("reports a chart component imported from a server page", async () => {
  expect(await findings({ [panelPath]: panel, "packages/demo/src/frontend/page.tsx": "import { Panel } from './Panel';" })).toEqual([
    panelFinding,
  ]);
});

test.each(["island.tsx", "client.tsx", "island.ts", "client.ts"])("accepts a component imported only from .%s", async (extension) => {
  expect(
    await findings({ [panelPath]: panel, [`packages/demo/src/frontend/Page.${extension}`]: "import { Panel } from './Panel';" }),
  ).toEqual([]);
});

test.each([
  ["Chart as Plot", "Plot", ""],
  ["ChartExplorer", "ChartExplorer", ""],
  ["ChartSnapshotView", "ChartSnapshotView", ""],
  ["StatCell", "StatCell", " trend={[1, 2]}"],
  ["StatCell as Cell", "Cell", " trend={[1, 2]}"],
] as const)("detects the local chart binding %s", async (binding, tag, attributes) => {
  expect(await findings({ [panelPath]: `import { ${binding} } from '@k2b/ui';\nconst Page = () => <${tag}${attributes} />;` })).toEqual([
    panelFinding,
  ]);
});

test.each(["Chart", "ChartExplorer", "ChartSnapshotView", "StatCell"])("detects namespace UI.%s", async (tag) => {
  const attribute = tag === "StatCell" ? " trend={[1, 2]}" : "";
  expect(await findings({ [panelPath]: `import * as UI from '@k2b/ui';\nconst Page = () => <UI.${tag}${attribute} />;` })).toEqual([
    panelFinding,
  ]);
});

test("reports only the first chart element in a module", async () => {
  expect(await findings({ [panelPath]: `${panel}\nconst Other = () => <Chart />;` })).toEqual([panelFinding]);
});

test.each([
  "import { StatCell } from '@k2b/ui'; const Page = () => <StatCell label='Count' value='1' />;",
  "import * as UI from '@k2b/ui'; const Page = () => <UI.StatCell />;",
  "import { Chart } from './other'; const Page = () => <Chart />;",
  "import type { Chart } from '@k2b/ui'; const Page = () => <Chart />;",
  "import { type Chart } from '@k2b/ui'; const Page = () => <Chart />;",
  "const Chart = () => null; const Page = () => <Chart />;",
])("accepts JSX without a value-bound shared chart: %s", async (source) => {
  expect(await findings({ [panelPath]: source })).toEqual([]);
});

test.each([
  "import type { X } from './Panel';",
  "import { type X } from './Panel';",
  "export type { X } from './Panel';",
  "export { type X } from './Panel';",
])("ignores a page's type-only dependency: %s", async (dependency) => {
  expect(
    await findings({
      [panelPath]: panel,
      "packages/demo/src/frontend/Page.island.tsx": "import { Panel } from './Panel';",
      "packages/demo/src/frontend/page.tsx": dependency,
    }),
  ).toEqual([]);
});

test("a type-only island import leaves the component without a value importer", async () => {
  expect(await findings({ [panelPath]: panel, "packages/demo/src/frontend/Page.island.tsx": "import type { X } from './Panel';" })).toEqual(
    [panelFinding],
  );
});

test.each(["page.tsx", "Page.island.tsx"])("follows re-export barrels imported by %s", async (entry) => {
  expect(
    await findings({
      [panelPath]: panel,
      "packages/demo/src/frontend/index.ts": "export { Panel } from './Panel';",
      [`packages/demo/src/frontend/${entry}`]: "import { Panel } from './index';",
    }),
  ).toEqual(entry === "page.tsx" ? [panelFinding] : []);
});

test.each([
  "import { Panel } from '@/frontend/Panel';",
  "import Panel from './Panel';",
  "import './Panel';",
  "import {} from './Panel';",
  "export * from './Panel';",
  "export * as plots from './Panel';",
  "const plot = import('./Panel');",
  "import { Panel } from './Panel.js';",
  "import { Panel } from './Panel.jsx';",
] as const)("follows value dependency: %s", async (dependency) => {
  expect(await findings({ [panelPath]: panel, "packages/demo/src/frontend/Page.island.tsx": dependency })).toEqual([]);
  expect(await findings({ [panelPath]: panel, "packages/demo/src/frontend/page.tsx": dependency })).toEqual([panelFinding]);
});

test.each(["index.ts", "index.tsx"])("resolves directory imports through %s", async (index) => {
  expect(
    await findings({
      [panelPath]: panel,
      [`packages/demo/src/frontend/plots/${index}`]: "export { Panel } from '../Panel';",
      "packages/demo/src/frontend/Page.island.tsx": "import { Panel } from './plots';",
    }),
  ).toEqual([]);
});

test("a server importer still fails when an island also imports the component", async () => {
  expect(
    await findings({
      [panelPath]: panel,
      "packages/demo/src/frontend/Page.island.tsx": "import { Panel } from './Panel';",
      "packages/demo/src/frontend/page.tsx": "import { Panel } from './Panel';",
    }),
  ).toEqual([panelFinding]);
});

test.each(["test.ts", "spec.tsx", "browser-harness.tsx", "browser-fixture.ts", "browser-suite.tsx"])(
  "excludes .%s modules as chart renderers and importers",
  async (extension) => {
    expect(
      await findings({
        [panelPath]: panel,
        "packages/demo/src/frontend/Page.island.tsx": "import { Panel } from './Panel';",
        [`packages/demo/src/frontend/page.${extension}`]: `import { Panel } from './Panel';\n${panel}`,
      }),
    ).toEqual([]);
  },
);

test("fixture and cross-package imports cannot hydrate a module", async () => {
  expect(
    await findings(
      {
        [panelPath]: panel,
        "packages/demo/fixture/Page.island.tsx": "import { Panel } from '../src/frontend/Panel';",
        "packages/other/src/Page.island.tsx": "import { Panel } from '../../demo/src/frontend/Panel';",
      },
      ["demo", "other"],
    ),
  ).toEqual([panelFinding]);
});

test.each(["ui", "cloud", "ssr"])("exempts the %s library from island requirements", async (id) => {
  expect(await findings({ [`packages/${id}/src/Panel.tsx`]: panel })).toEqual([]);
});

test("docs and non-workspace packages are exempt from island requirements", async () => {
  expect(await findings({ "docs-site/src/Panel.tsx": panel, "packages/unlisted/src/Panel.tsx": panel })).toEqual([]);
});

test("a cycle with no server entry counts as hydrated", async () => {
  expect(
    await findings({
      [panelPath]: `${panel}\nimport './Other';`,
      "packages/demo/src/frontend/Other.tsx": "import './Panel';",
    }),
  ).toEqual([]);
});

test.each(["A", "Z"])("does not cache a cycle before checking server importers (%s)", async (prefix) => {
  expect(
    await findings({
      [panelPath]: `${panel}\nimport './${prefix}Other';`,
      [`packages/demo/src/frontend/${prefix}Other.tsx`]: `${panel}\nimport './Panel';`,
      "packages/demo/src/frontend/page.tsx": `import './${prefix}Other';`,
    }),
  ).toEqual([`packages/demo/src/frontend/${prefix}Other.tsx:2`, panelFinding].sort());
});

test("names the server importer, or that no island imports the module", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-chart-rendering-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ workspaces: { packages: ["packages/demo"] } }));
    const write = async (file: string, source: string) => {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), source);
    };
    await write(panelPath, panel);
    await write("packages/demo/src/frontend/Page.island.tsx", "import { Panel } from './Panel';");
    await write("packages/demo/src/pages/page.tsx", "import { Panel } from '../frontend/Panel';");
    await write("packages/demo/src/frontend/Lonely.tsx", panel);
    const messages = (await rule.run({ workspaceRoot: root, fix: false, flags: new Set() })).map(
      (finding) => `${relative(root, finding.file ?? "")}: ${finding.message}`,
    );
    expect(messages.sort()).toEqual([
      expect.stringContaining("packages/demo/src/frontend/Lonely.tsx: <Chart> renders outside an island (no island imports it)"),
      expect.stringContaining(
        "packages/demo/src/frontend/Panel.tsx: <Chart> renders outside an island (../pages/page.tsx imports it outside an island)",
      ),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
