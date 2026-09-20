import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "assistant-empty-chat-"));
const serovalLink = resolve(import.meta.dir, "../../node_modules/seroval");
const createdSerovalLink = !existsSync(serovalLink);
if (createdSerovalLink) symlinkSync(resolve(import.meta.dir, "../../../cloud/node_modules/seroval"), serovalLink, "dir");
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (createdSerovalLink) unlinkSync(serovalLink);
});

const { createArtifactWorkspace } = await import("./Workspace");
const { workspaceSelectionHref, taskTab } = await import("./workspace-state");
const { AppWorkspace, Placeholder } = await import("@k2b/ui");

test("URL-selected panel reserves its space during SSR without loading its content", () => {
  const href = workspaceSelectionHref("/app/assistant?conversation=chat", taskTab("task01", "task01"));
  const html = renderToString(() => {
    const controller = createArtifactWorkspace(href);
    expect(controller.state().active).toBe(taskTab("task01", "task01").key);
    expect(controller.mobile()).toBe("workspace");
    return createComponent(AppWorkspace, { get children() {
      return createComponent(AppWorkspace.Content, { get children() {
        return createComponent(AppWorkspace.Main, { get children() {
          return [
            createComponent(AppWorkspace.MainPane, { id: "chat", label: "Chat", children: "Chat" }),
            createComponent(AppWorkspace.MainPane, { id: "workspace", label: "Workspace", open: controller.state().tabs.length > 0, defaultSize: 620,
              get children() { return createComponent(Placeholder, { state: "loading", title: "Loading" }); } }),
          ];
        } });
      } });
    } });
  });
  expect(html).toContain('data-workspace-main-region="workspace"');
  expect(html).toContain('aria-busy="true"');
  expect(html).toContain('620px');
  expect(createArtifactWorkspace("/app/assistant?workspace=broken").state().tabs).toEqual([]);
});
