import { afterEach, expect, mock, test } from "bun:test";
import type { Principal } from "@k2b/cloud/contracts";
import { createComponent } from "solid-js";
import { delegateEvents, render } from "solid-js/web";
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
let granted: { param: { id: string }; json: { principal: Principal } } | undefined;
mock.module("../src/api/client", () => ({
  apiClient: {
    templates: {
      $get: async () => Response.json({ items: [], next: null }),
      admin: {
        $get: async () => Response.json({ items: [item], next: null }),
        ":id": {
          grants: {
            $get: async () => Response.json([]),
            $post: async (input: NonNullable<typeof granted>) => {
              granted = input;
              return Response.json({
                id: "22222222-2222-4222-8222-222222222222",
                principal: input.json.principal,
                permission: "read",
                createdAt: "2026-09-20T00:00:00Z",
              });
            },
          },
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
  granted = undefined;
});

for (const kind of ["standalone", "agent"] as const) {
  test(`template permissions send the selected ${kind} to the grant transport`, async () => {
    const dom = createDomTestHarness();
    // happy-dom has no Popover API; exercise the real picker's result list.
    const prototype = dom.window.HTMLElement.prototype;
    const open = new WeakSet<object>();
    const matches = prototype.matches;
    Object.assign(prototype, {
      matches(this: Element, selector: string) {
        return selector === ":popover-open" ? open.has(this) : matches.call(this, selector);
      },
      showPopover(this: object) {
        open.add(this);
      },
      hidePopover(this: object) {
        open.delete(this);
      },
      scrollIntoView() {},
    });
    const machine = {
      id: "33333333-3333-4333-8333-333333333333",
      name: `Atlas ${kind}`,
      kind,
      appId: null,
      resourceType: null,
      resourceId: null,
    };
    const search = Promise.withResolvers<URL>();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        search.resolve(url);
        return Response.json({ items: [{ kind: "service_account", serviceAccount: machine }] });
      },
      { preconnect: originalFetch.preconnect },
    );
    const { TemplateList } = await import("../src/frontend/Templates");
    delegateEvents(["input", "click"]);
    const dispose = render(() => createComponent(TemplateList, { admin: true }), dom.root);
    cleanup = () => {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    };
    await flush();
    [...dom.root.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Who can use this template?"))!
      .click();
    await flush();
    const dialog = dom.document.querySelector("dialog")!;
    const picker = dialog.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    const selected = new Promise<HTMLButtonElement>((resolve) => {
      const observer = new MutationObserver(() => {
        const option = [...dialog.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((element) =>
          element.textContent?.includes(machine.name),
        );
        if (option) {
          observer.disconnect();
          resolve(option);
        }
      });
      observer.observe(dialog, { childList: true, subtree: true });
    });
    picker.value = "Atlas";
    picker.dispatchEvent(new Event("input", { bubbles: true }));
    const request = await search.promise;
    expect(request.pathname).toBe("/api/accounts/entities");
    expect(request.searchParams.get("kinds")).toBe("user,group,service_account");
    const option = await selected;
    const options = [...dialog.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(options.some((option) => option.textContent?.includes("Public"))).toBe(false);
    option.click();
    await flush();
    expect(granted).toEqual({
      param: { id: item.id },
      json: {
        principal: { type: "service_account", serviceAccountId: machine.id },
      },
    });
    expect(dialog.textContent).not.toContain("Could not");
    dialog.querySelector<HTMLButtonElement>('button[aria-label="close dialog"]')!.click();
    await flush();
  });
}
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
