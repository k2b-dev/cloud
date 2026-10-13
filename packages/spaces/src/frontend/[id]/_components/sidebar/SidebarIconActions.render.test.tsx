import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { selectHtml } from "../../../../../../../tests/fixtures/select-html";

const root = mkdtempSync(join(tmpdir(), "spaces-sidebar-icon-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: CreateItemButton } = await import("./CreateItemButton");
const { default: CopyICalButton } = await import("./CopyICalButton");
const { default: SearchButton } = await import("../search/SearchButton");
const { default: ViewLinks } = await import("./ViewLinks");
const { default: SpaceSidebar } = await import("./SpaceSidebar");
const { LocaleProvider } = await import("@k2b/ui");

describe("Spaces sidebar icon actions", () => {
  for (const variant of ["desktop", "collapsed"] as const) {
    test.each([
      ["en", "List"],
      ["de", "Liste"],
    ])(`names the list view with a list icon in the ${variant} sidebar (%s)`, (locale, label) => {
      const html = renderToString(() =>
        createComponent(LocaleProvider, {
          locale,
          get children() {
            return createComponent(ViewLinks, { spaceId: "Space1", query: "view=list", currentView: "list", variant });
          },
        }),
      );
      const link = html.match(/<a\b[^>]*href="[^"]*view=list[^"]*"[^>]*>[\s\S]*?<\/a>/)?.[0];

      expect(link).toBeDefined();
      expect(link).toContain("ti-layout-list");
      expect(link).toContain(variant === "collapsed" ? `aria-label="${label}"` : `>${label}<`);
      expect(link).not.toContain("ti-home");
    });
  }

  test.each(["desktop", "collapsed"] as const)("renders %s view links with SSR search state", (variant) => {
    const html = renderToString(() =>
      createComponent(ViewLinks, { spaceId: "Space1", query: "view=list&q=initial&status=all", currentView: "list", variant }),
    );
    expect(html.match(/href=/g)).toHaveLength(4);
    expect(html).toContain("view=table&amp;q=initial&amp;status=all");
  });

  test("uses the workspace icon action geometry for primary controls", () => {
    const create = renderToString(() =>
      createComponent(CreateItemButton, { spaceId: "Space1", columns: [], tags: [], variant: "icon", defaultType: "task" }),
    );
    const search = renderToString(() => createComponent(SearchButton, { spaceId: "Space1", spaceName: "Planning", variant: "icon" }));

    expect(create).toContain("k2b-app-workspace__sidebar-icon-action");
    expect(search).toContain("k2b-app-workspace__sidebar-icon-action");
    expect(create).not.toContain("k2b-icon-button");
    expect(search).not.toContain("k2b-spotlight-button");
  });

  test("uses the workspace icon action geometry for the iCal control", () => {
    const html = renderToString(() => createComponent(CopyICalButton, { icalToken: "calendar-token", variant: "icon" }));

    expect(html).toContain("k2b-app-workspace__sidebar-icon-action");
    expect(html).not.toContain("k2b-icon-button");
  });

  test.each([
    ["en", "Switch Space", "All Spaces"],
    ["de", "Space wechseln", "Alle Spaces"],
  ])("names the space in the switcher above its views and moves All spaces into actions (%s)", async (locale, purpose, allLabel) => {
    const space = {
      id: "Space1",
      name: "Launch plan",
      description: null,
      color: "#6366f1",
      icalToken: "calendar-token",
      createdAt: "2026-08-10T10:00:00.000Z",
      updatedAt: "2026-08-10T10:00:00.000Z",
      columns: [],
      virtualColumns: [],
      tags: [],
      templates: [],
    };
    const html = renderToString(() =>
      createComponent(LocaleProvider, {
        locale,
        get children() {
          return createComponent(SpaceSidebar, {
            ctx: {
              space,
              columns: [],
              tags: [],
              currentView: "list",
              hasOverride: false,
              settings: { view: "list", hideSettings: false },
              query: "view=list",
              canWrite: false,
            },
            baseUrl: "/app/spaces/Space1",
          });
        },
      }),
    );
    const section = html
      .match(/<section\b[^>]*k2b-app-workspace__sidebar-section[\s\S]*?<\/section>/g)
      ?.find((part) => part.includes("view=list"));
    expect(section).not.toContain("<h2>Launch plan</h2>");
    expect((await selectHtml(html, ".k2b-sidebar-switcher__trigger"))[0]?.attributes["aria-label"]).toBe("Launch plan");
    expect((await selectHtml(html, ".k2b-sidebar-switcher .k2b-sr-only"))[0]?.text).toContain(purpose);
    const snapshot = (await selectHtml(html, "script[data-cloud-workspace-navigation]"))[0]?.text;
    expect(snapshot).toContain('"switchLabel":"' + purpose + '"');
    expect(snapshot).not.toContain('"id":"all"');
    expect(await selectHtml(html, '.k2b-app-workspace__sidebar-icon-action[href="/app/spaces"]')).toHaveLength(0);
    expect((await selectHtml(html, '.k2b-sidebar-switcher__actions a[href="/app/spaces"]'))[0]?.text).toContain(allLabel);
    expect(section).toMatch(/<a\b[^>]*aria-current="page"[^>]*>/);
  });
});
