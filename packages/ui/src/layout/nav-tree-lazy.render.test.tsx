import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-nav-tree-lazy-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: AppWorkspace } = await import("./AppWorkspace");

describe("NavTree branches that load when they open", () => {
  test("an item with hasChildren is a closed branch with its disclosure before any child renders", () => {
    const html = renderToString(() =>
      createComponent(AppWorkspace.NavTree, {
        ariaLabel: "Notes",
        get children() {
          return [
            createComponent(AppWorkspace.NavTree.Item, { id: "folder", label: "Folder", hasChildren: true }),
            createComponent(AppWorkspace.NavTree.Item, { id: "leaf", label: "Leaf" }),
          ];
        },
      }),
    );
    const tag = (id: string) => new RegExp(`<div[^>]*data-k2b-nav-tree-id="${id}"[^>]*>`).exec(html)?.[0] ?? "";
    expect(tag("folder")).toContain('aria-expanded="false"');
    expect(tag("leaf")).not.toContain("aria-expanded");
    expect(html.split("data-k2b-nav-tree-toggle")).toHaveLength(2);
  });
});
