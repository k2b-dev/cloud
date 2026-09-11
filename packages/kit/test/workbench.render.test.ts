import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { starter } from "../src/starter";
import { validateProject } from "../src/project";
const root = mkdtempSync(join(tmpdir(), "kit-ssr-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: Workbench } = await import("../src/frontend/Workbench.island.tsx");
const { default: QueryConsole } = await import("../src/frontend/QueryConsole.island.tsx");
const { default: Overview } = await import("../src/frontend/Overview.island.tsx");
const { LocaleProvider } = await import("@k2b/ui");
const project = {
  ...starter,
  id: "abc123",
  revision: 1,
  sdkVersion: 1,
  updatedAt: new Date().toISOString(),
  permission: "admin" as const,
  entries: validateProject(starter).entries,
};
test("use and edit SSR render without browser globals or cleanup failures", () => {
  for (const edit of [false, true]) {
    for (const locale of ["en", "de"]) {
      const html = renderToString(() =>
        createComponent(LocaleProvider, {
          locale,
          get children() {
            return createComponent(Workbench, {
              project,
              edit,
              entry: project.entries[0]!.path,
              access: [],
              userId: "test",
              databaseEnabled: true,
            });
          },
        }),
      );
      expect(html).toContain(edit ? "kit-edit" : "kit-use");
      expect(html.includes("kit-editor-panes")).toBe(edit);
      expect(html).toContain("kit-launch-button");
      expect(html).toContain(locale === "de" ? "Lokale Daten" : "Local data");
      if (!edit) expect(html).toContain(locale === "de" ? "Starten" : "Launch");
      else {
        expect(html).toContain(locale === "de" ? "Abbrechen" : "Cancel");
        expect(html).toContain("textarea");
      }
      expect(html).not.toContain("kit-run-toolbar");
    }
  }
});
test("overview uses the shared workspace and localized create/search controls", () => {
  const html = renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(Overview, {
          items: [project],
          page: 1,
          hasNext: false,
        });
      },
    }),
  );
  expect(html).toContain("k2b-app-overview");
  expect(html).toContain("Leere App");
  expect(html).toContain("CSV-Werkstatt");
  expect(html).toContain("Neue App");
  expect(html).toContain("Suchen");
  expect(html).toContain("/app/kit/abc123");
});

test("runtime select displays its visible label instead of the tab value", async () => {
  const { RuntimeView } = await import("../src/frontend/RuntimeView.tsx");
  const { UiNode } = await import("../src/runtime/protocol");
  const html = renderToString(() =>
    createComponent(RuntimeView, {
      nodes: [
        UiNode.parse({
          id: "delimiter",
          kind: "select",
          label: "Trennzeichen",
          value: "\t",
          options: [
            {
              value: "\t",
              label: "Tabulator",
              icon: "ti ti-arrow-right",
              description: "Tab-separated columns",
            },
          ],
        }),
      ],
      busy: false,
      event: () => {},
    }),
  );
  expect(html).toContain("Tabulator");
  expect(html).toContain("ti ti-arrow-right");
});

test("workbench renders shared list actions and Markdown without remote image resources", async () => {
  const { RuntimeView } = await import("../src/frontend/RuntimeView.tsx");
  const { UiNode } = await import("../src/runtime/protocol");
  const html = renderToString(() =>
    createComponent(RuntimeView, {
      nodes: [
        UiNode.parse({
          id: "notes",
          kind: "markdown",
          value: "**Local** ![Receipt](https://example.com/pixel) <script>alert(1)</script>",
        }),
        UiNode.parse({
          id: "download",
          kind: "button",
          label: "Download export",
          disabled: true,
        }),
        UiNode.parse({
          id: "history",
          kind: "list",
          label: "Exports",
          items: [
            {
              id: "one",
              title: "result.csv",
              description: "2 rows",
              action: "download",
            },
          ],
          children: ["download"],
        }),
        UiNode.parse({
          id: "root",
          kind: "workbench",
          controls: ["notes"],
          content: ["history"],
          children: ["notes", "history"],
        }),
      ],
      busy: false,
      event: () => {},
    }),
  );
  expect(html).toContain("kit-runtime-controls");
  expect(html).toContain("result.csv");
  expect(html).toContain("2 rows");
  expect(html).toContain("Download export");
  expect(html).toContain("disabled");
  expect(html).toContain("<strong>Local</strong>");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<script>");
});

test("settings excludes local data and keeps admin tabs permission-gated", async () => {
  const { KitSettings } = await import("../src/frontend/KitSettings");
  for (const permission of ["admin", "write"] as const) {
    const html = renderToString(() =>
      createComponent(LocaleProvider, {
        locale: "en",
        get children() {
          return createComponent(KitSettings, {
            project: { ...project, permission },
            access: [],
            close: () => {},
            onSaved: () => {},
          });
        },
      }),
    );
    expect(html).not.toContain("Local data");
    expect(html).not.toContain('role="switch"');
    expect(html.includes('id="')).toBe(true);
    expect(html.includes(">General<")).toBe(permission === "admin");
    expect(html.includes(">Share<")).toBe(permission === "admin");
  }
});

test("local explorer renders localized controls without browser storage during SSR", async () => {
  const { LocalFiles } = await import("../src/frontend/LocalFiles");
  for (const locale of ["en", "de"]) {
    const html = renderToString(() =>
      createComponent(LocaleProvider, {
        locale,
        get children() {
          return createComponent(LocalFiles, { appId: "abc123", userId: "user", beforeDelete: async () => {} });
        },
      }),
    );
    expect(html).toContain(locale === "de" ? "Aktualisieren" : "Refresh");
    expect(html).toContain(locale === "de" ? "Noch keine lokalen Daten" : "No local data yet");
  }
});

test("Markdown navigation renders content without launch controls or console", () => {
  const files = [...starter.files, { path: "guide.md", content: "# Guide\n\n**Read me**\n\n<script>window.bad = true</script>" }];
  const withPage = { ...project, files, entries: validateProject({ ...starter, files }).entries };
  const html = renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "en",
      get children() {
        return createComponent(Workbench, { project: withPage, userId: "user", edit: false, entry: "guide.md", access: [] });
      },
    }),
  );
  expect(html).toContain("<strong>Read me</strong>");
  expect(html).not.toContain("kit-launch-button");
  expect(html).not.toContain("kit-console-header");
  expect(html).not.toContain("<script>window.bad");
});

test("all stdlib chart kinds render through the shared responsive Chart", async () => {
  const { RuntimeView } = await import("../src/frontend/RuntimeView");
  const { UiNode } = await import("../src/runtime/protocol");
  const configs = [
    {
      kind: "line",
      series: [
        {
          data: [
            { x: 0, y: 1 },
            { x: 1, y: 2 },
          ],
        },
      ],
    },
    { kind: "scatter", series: [{ data: [{ x: 0, y: 1 }] }] },
    { kind: "bar", data: [{ label: "A", value: 2 }] },
    { kind: "pie", data: [{ label: "A", value: 2 }] },
    { kind: "donut", data: [{ label: "A", value: 2 }] },
    { kind: "sparkline", data: [1, 2] },
    { kind: "histogram", data: [1, 2, 3] },
    { kind: "boxplot", groups: [{ label: "A", values: [1, 2, 3] }] },
    { kind: "gauge", value: 3 },
    { kind: "barGauge", data: [{ label: "A", value: 2 }] },
    { kind: "stat", label: "Count", value: 3 },
    { kind: "heatmap", data: [{ x: "A", y: "B", value: 3 }] },
    { kind: "map", series: [{ data: [{ latitude: 48, longitude: 10 }] }] },
    { kind: "stateTimeline", rows: [{ label: "A", intervals: [{ from: 0, to: 5, state: "ok" }] }] },
  ];
  for (const chart of configs) {
    const html = renderToString(() =>
      createComponent(RuntimeView, { nodes: [UiNode.parse({ id: "chart", kind: "chart", chart })], busy: false, event() {} }),
    );
    expect(html).toContain("<svg");
    expect(html).not.toContain("<script");
  }
});
test("SQL console renders its editor and controls during SSR", async () => {
  const html = renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "en",
      get children() {
        return createComponent(QueryConsole, {
          project,
          state: {
            enabled: true,
            globallyEnabled: true,
            provisioned: true,
            generation: 1,
            status: "ready",
            canAdmin: true,
            error: null,
            overview: null,
            tables: null,
          },
          queries: [],
          hasNext: false,
          initial: null,
        });
      },
    }),
  );
  expect(html).toContain("SQL console");
  expect(html).toContain("textarea");
  expect(html).toContain("kit-sql-main");
});
