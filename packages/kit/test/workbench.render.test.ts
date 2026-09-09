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
              userId: "user",
              edit,
              entry: project.entries[0]!.path,
              access: [],
            });
          },
        }),
      );
      expect(html).toContain(edit ? "kit-edit" : "kit-use");
      expect(html.includes("kit-editor-panes")).toBe(edit);
      expect(html).toContain("kit-launch-button");
      expect(html).toContain(locale === "de" ? "Lokale Daten löschen" : "Delete local data");
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

test("settings exposes admin tabs and keeps Use-only settings limited to local files", async () => {
  const { KitSettings } = await import("../src/frontend/KitSettings");
  for (const permission of ["admin", "write"] as const) {
    const html = renderToString(() =>
      createComponent(LocaleProvider, {
        locale: "en",
        get children() {
          return createComponent(KitSettings, {
            userId: "user",
            project: { ...project, permission },
            access: [],
            close: () => {},
            onSaved: () => {},
          });
        },
      }),
    );
    expect(html).toContain("Local data");
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
          return createComponent(LocalFiles, { appId: "abc123", userId: "user" });
        },
      }),
    );
    expect(html).toContain(locale === "de" ? "Aktualisieren" : "Refresh");
    expect(html).toContain(locale === "de" ? "Noch keine lokalen Daten" : "No local data yet");
  }
});
