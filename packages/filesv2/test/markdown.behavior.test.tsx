import { afterEach, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { MarkdownLaunch } from "../src/contracts";

const launch: MarkdownLaunch = {
  kind: "markdown",
  managed: true,
  canWrite: true,
  url: "https://filegate.test/direct",
  base: {
    id: "cloud:users:test",
    name: "test",
    area: "cloud",
    kind: "users",
    status: "existing",
    reason: null,
    indexEnabled: true,
    versioningEnabled: true,
  },
  entry: { name: "Notes.md", path: "Notes.md", directory: false, size: 5, modified: "2026-09-20T00:00:00Z", revision: "metadata-old" },
};
const saves: Array<{ options: { expectedRevision?: string }; content: string }> = [];
let failSave = true;
mock.module("../src/api/client", () => ({ apiClient: { bases: { ":baseId": { editor: { $post: async () => Response.json(launch) } } } } }));
mock.module("../src/frontend/uploads", () => ({
  uploadFile: async (_base: string, _path: string, body: Blob, options: { expectedRevision?: string }) => {
    saves.push({ options, content: await body.text() });
    if (failSave) throw new Error("The file changed");
    return { base: launch.base, entry: { ...launch.entry, revision: "new-revision" } };
  },
}));
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
let cleanup = () => {};
afterEach(() => {
  cleanup();
  saves.length = 0;
  failSave = true;
});
test("Markdown saves the revision of loaded bytes and preserves a draft after conflict", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => new Response("hello", { headers: { etag: '"loaded-revision"' } }), {
    preconnect: originalFetch.preconnect,
  });
  const { default: MarkdownDocument } = await import("../src/frontend/MarkdownDocument");
  let guard: (() => Promise<boolean>) | null = null;
  const dispose = render(
    () =>
      createComponent(MarkdownDocument, {
        launch,
        onBack: () => {},
        onGuard: (value) => {
          guard = value;
        },
      }),
    dom.root,
  );
  cleanup = () => {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  };
  await flush();
  const editor = dom.root.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(editor).not.toBeNull();
  expect(editor.value).toBe("hello");
  const tools = [...dom.root.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button')];
  expect(tools.at(-1)!.getAttribute("aria-label")).toBe("Close");
  expect(tools.at(-2)!.getAttribute("aria-label")).toBe("Save");
  expect(dom.root.textContent).not.toContain("Back to folder");
  expect(dom.root.querySelector('[data-variant="embedded"][data-fill="true"]')).not.toBeNull();
  expect(await guard!()).toBe(true);
  editor.value = "my draft";
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
  editor.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true }));
  await flush();
  expect(saves).toHaveLength(1);
  expect(dom.root.querySelector(".ti-check")).toBeNull();
  expect(saves[0]).toMatchObject({ content: "my draft", options: { expectedRevision: "loaded-revision" } });
  expect(editor.value).toBe("my draft");
  expect(dom.root.textContent).toContain("The file changed");
  expect(dom.root.textContent).toContain("Save as copy");
  const link = dom.document.createElement("a");
  link.href = "/app/filesv2";
  link.textContent = "Workspace link";
  let allowed = false;
  link.addEventListener("click", (event) => {
    event.preventDefault();
    void guard!().then((value) => {
      allowed = value;
    });
  });
  dom.root.append(link);
  link.click();
  await flush();
  const confirm = [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Confirm")!;
  expect(confirm).toBeDefined();
  confirm.click();
  await flush();
  expect(allowed).toBe(true);
  expect(dom.document.querySelector("dialog")).toBeNull();
  expect(editor.value).toBe("my draft");
  expect(dom.root.textContent).toContain("Unsaved changes");
  failSave = false;
  editor.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true }));
  await flush();
  expect(dom.root.textContent).not.toContain("Unsaved changes");
  expect(await guard!()).toBe(true);
  expect(dom.root.querySelector('[role="toolbar"]')!.textContent).not.toContain("Saved");
  expect(dom.root.querySelector(".ti-check")).not.toBeNull();
  editor.value = "next draft";
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
  expect(dom.root.querySelector(".ti-check")).toBeNull();
  editor.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true }));
  await flush();
  expect(dom.root.querySelector(".ti-check")).not.toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 1600));
  expect(dom.root.querySelector(".ti-check")).toBeNull();
  dispose();
  expect(guard).toBeNull();
});
