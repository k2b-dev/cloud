import { describe, expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { PublicConfiguration } from "../contracts";

// #1303: an unreadable saved configuration is named, and reset is an explicit, confirmed action.
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const TIMEOUT = 20_000;
const area = { enabled: false, root: "cloud", prefix: "", homes: "users", groups: "groups", archive: "archive" };
const configuration = (unreadable: boolean): PublicConfiguration => ({
  url: "",
  cloud: { ...area, autoCreate: false, autoArchive: true },
  freeipa: { ...area, root: "freeipa" },
  collabora: { url: "", internalUrl: "", wopiOrigin: "", documentFormat: "odf" },
  tokenConfigured: false,
  unreadable,
});

async function setup(unreadable: boolean, hold?: Promise<void>) {
  const dom = createDomTestHarness();
  const { default: Settings } = await import("./Settings");
  const { dialogCore } = await import("@k2b/ui");
  const requests: Array<{ method: string; url: string }> = [];
  let saved = 0;
  let dirty = { dirty: false, saving: false };
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: unknown, init?: RequestInit) => {
        requests.push({ method: init?.method ?? "GET", url: String(input instanceof Request ? input.url : input) });
        await hold;
        return Response.json({ reset: true });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  const dispose = render(
    () =>
      createComponent(Settings, {
        configuration: configuration(unreadable),
        availability: { localLinuxEnabled: true, freeipaEnabled: true },
        onSaved: async () => {
          saved += 1;
        },
        onDirtyChange: (value: boolean, saving: boolean) => {
          dirty = { dirty: value, saving };
        },
      }),
    dom.root,
  );
  await tick();
  const button = (text: string, scope: ParentNode = dom.document) =>
    Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.trim() === text);
  return {
    ...dom,
    button,
    requests,
    saved: () => saved,
    dirty: () => dirty,
    cleanup: () => {
      dialogCore.close();
      dispose();
      fetch.mockRestore();
      dom.cleanup();
    },
  };
}

describe("Files settings with an unreadable saved configuration", () => {
  if (isServer) {
    test.skip("requires browser conditions and Solid DOM preload", () => {});
    return;
  }

  test(
    "a readable configuration shows no notice and no reset",
    async () => {
      const ui = await setup(false);
      try {
        expect(ui.document.querySelector('.k2b-notice-card[data-tone="warning"]')).toBeNull();
        expect(ui.button("Reset configuration")).toBeUndefined();
        expect(ui.document.body.textContent).toContain("No token is configured yet.");
      } finally {
        ui.cleanup();
      }
    },
    TIMEOUT,
  );

  test(
    "the notice explains the state and reset deletes only after confirmation",
    async () => {
      const ui = await setup(true);
      try {
        const notice = ui.document.querySelector<HTMLElement>('.k2b-notice-card[data-tone="warning"]');
        expect(notice?.textContent).toContain("The saved configuration cannot be read");
        expect(notice?.textContent).toContain("APP_SECRET");
        expect(ui.document.body.textContent).toContain("Enter the token again to replace the unreadable saved configuration.");

        ui.button("Reset configuration", notice!)!.click();
        await tick();
        const dialog = ui.document.querySelector("dialog");
        expect(dialog?.textContent).toContain("Delete the saved Files configuration");
        expect(ui.requests).toEqual([]);
        const confirm = Array.from(dialog!.querySelectorAll<HTMLButtonElement>("button")).at(-1)!;
        confirm.click();
        await tick();
        await tick();
        expect(ui.requests).toHaveLength(1);
        expect(ui.requests[0]!.method).toBe("DELETE");
        expect(new URL(ui.requests[0]!.url, "http://cloud.test").pathname).toBe("/api/filesv2/admin/configuration");
        expect(ui.saved()).toBe(1);
      } finally {
        ui.cleanup();
      }
    },
    TIMEOUT,
  );

  test(
    "while a reset is pending the form cannot save over it",
    async () => {
      let release!: () => void;
      const ui = await setup(
        true,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      try {
        const url = ui.document.querySelector<HTMLInputElement>('input[name="filegate-url"]')!;
        url.value = "http://filegate:4000";
        url.dispatchEvent(new Event("input", { bubbles: true }));
        await tick();
        const notice = ui.document.querySelector<HTMLElement>('.k2b-notice-card[data-tone="warning"]')!;
        ui.button("Reset configuration", notice)!.click();
        await tick();
        Array.from(ui.document.querySelector("dialog")!.querySelectorAll<HTMLButtonElement>("button")).at(-1)!.click();
        await tick();
        expect(ui.requests.map((request) => request.method)).toEqual(["DELETE"]);
        expect(ui.dirty()).toEqual({ dirty: true, saving: true });
        expect(ui.document.querySelectorAll("fieldset:disabled").length).toBe(ui.document.querySelectorAll("fieldset").length);
        ui.document.querySelector("form")!.requestSubmit();
        ui.button("Save changes")?.click();
        await tick();
        expect(ui.requests.map((request) => request.method)).toEqual(["DELETE"]);
        release();
        await tick();
        await tick();
        expect(ui.saved()).toBe(1);
        // The drafts typed before the reset give way to the stored defaults.
        expect(ui.dirty()).toEqual({ dirty: false, saving: false });
        expect(url.value).toBe("");
      } finally {
        release();
        ui.cleanup();
      }
    },
    TIMEOUT,
  );
});
