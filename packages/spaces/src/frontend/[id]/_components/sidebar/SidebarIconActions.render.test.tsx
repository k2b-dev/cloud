import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "spaces-sidebar-icon-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: CreateItemButton } = await import("./CreateItemButton");
const { default: CopyICalButton } = await import("./CopyICalButton");
const { default: SearchButton } = await import("../search/SearchButton");
const { default: ViewLinks } = await import("./ViewLinks");

describe("Spaces sidebar icon actions", () => {
  test.each(["mobile", "desktop", "collapsed"] as const)("renders %s view links with SSR search state", (variant) => {
    const html = renderToString(() =>
      createComponent(ViewLinks, { spaceId: "Space1", query: "view=list&q=initial&status=all", currentView: "list", variant }),
    );
    expect(html.match(/href=/g)).toHaveLength(4);
    if (variant !== "collapsed") expect(html.match(new RegExp(`data-mode="${variant}"`, "g"))).toHaveLength(4);
    expect(html).toContain("view=table&amp;q=initial&amp;status=all");
  });

  test("uses the workspace icon action geometry for primary controls", () => {
    const create = renderToString(() =>
      createComponent(CreateItemButton, { spaceId: "Space1", columns: [], tags: [], variant: "icon", defaultType: "task" }),
    );
    const search = renderToString(() =>
      createComponent(SearchButton, { spaceId: "Space1", spaceName: "Planning", columns: [], query: "", variant: "icon" }),
    );

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
});
