import { afterEach, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

const item = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Minutes",
  description: "",
  filename: "minutes.md",
  size: 3,
  updatedAt: "2026-09-20T00:00:00Z",
};
let patch: { json: unknown; resolve: (response: Response) => void } | undefined;
mock.module("../src/api/client", () => ({
  apiClient: {
    templates: {
      $get: async () => Response.json({ items: [], next: null }),
      admin: {
        $get: async () => Response.json({ items: [item], next: null }),
        ":id": {
          $patch: (input: { json: unknown }) =>
            new Promise<Response>((resolve) => {
              patch = { json: input.json, resolve };
            }),
        },
      },
    },
  },
}));
const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};
let cleanup = () => {};
afterEach(() => {
  cleanup();
  patch = undefined;
});
test("template editing publishes metadata and replacement bytes in one request and cannot dismiss a pending save", async () => {
  const dom = createDomTestHarness();
  const { TemplateList } = await import("../src/frontend/Templates");
  const dispose = render(() => createComponent(TemplateList, { admin: true }), dom.root);
  cleanup = () => {
    dispose();
    dom.cleanup();
  };
  await flush();
  [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Edit"))!.click();
  await flush();
  const dialog = dom.document.querySelector("dialog")!;
  const name = dialog.querySelector<HTMLInputElement>('input[maxlength="160"]')!;
  name.value = "Updated minutes";
  name.dispatchEvent(new Event("input", { bubbles: true }));
  const file = dialog.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(file, "files", { configurable: true, value: [new File(["new content"], "updated.md")] });
  file.dispatchEvent(new Event("change", { bubbles: true }));
  await flush();
  dialog.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await flush();
  expect(patch?.json).toEqual({ name: "Updated minutes", description: "", file: { filename: "updated.md", content: btoa("new content") } });
  dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
  await flush();
  expect(dom.document.querySelector("dialog")).toBe(dialog);
  patch!.resolve(Response.json({ ...item, name: "Updated minutes" }));
  await flush();
  expect(dom.document.querySelector("dialog")).toBeNull();
  dispose();
  const { openTemplatePicker } = await import("../src/frontend/Templates");
  const result = openTemplatePicker();
  await flush();
  expect(dom.document.body.textContent).toContain("No templates available");
  expect(dom.document.querySelector(".filesv2-template-list")).not.toBeNull();
  dom.document.querySelector<HTMLButtonElement>('button[aria-label="close dialog"]')!.click();
  expect(await result).toBeNull();
});
