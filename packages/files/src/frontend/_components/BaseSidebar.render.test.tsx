import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { selectHtml } from "../../../../../tests/fixtures/select-html";

const root = mkdtempSync(join(tmpdir(), "files-sidebar-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: BaseSidebar } = await import("./BaseSidebar");

test("a user without storage sees one inline line where the first storage row would be", async () => {
  const html = renderToString(() => createComponent(BaseSidebar, { bases: [], currentBaseType: "search", currentBaseId: "" }));
  const [placeholder, ...others] = await selectHtml(html, ".k2b-app-workspace__sidebar-body > .k2b-placeholder");

  expect(others).toEqual([]);
  expect(placeholder?.attributes["data-variant"]).toBe("inline");
  expect(placeholder?.attributes["data-align"]).toBe("left");
  expect(placeholder?.text).toBe("No accessible bases");
  expect(await selectHtml(html, '.k2b-placeholder[data-variant="inline"] .k2b-placeholder__icon > i.ti-folder-off')).toHaveLength(1);
});

test("storage rows replace the empty line", async () => {
  const html = renderToString(() =>
    createComponent(BaseSidebar, { bases: [{ type: "home", id: "ada", name: "Ada" }], currentBaseType: "home", currentBaseId: "ada" }),
  );

  expect(await selectHtml(html, ".k2b-placeholder")).toEqual([]);
  expect(html).toContain('href="/app/files/home"');
});
