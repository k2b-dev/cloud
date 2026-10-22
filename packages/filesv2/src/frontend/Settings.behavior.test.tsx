import { describe, expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { PublicConfiguration } from "../contracts";

// #1303: an unreadable saved configuration is named, and reset is an explicit, confirmed action.
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const TIMEOUT = 20_000;
const area = { enabled: false, root: "cloud", prefix: "", homes: "users", groups: "groups", archive: "archive" };
const configuration = (unreadable: boolean, activityRetentionDays = 365): PublicConfiguration => ({
  url: "",
  activityRetentionDays,
  cloud: { ...area, autoCreate: false, autoArchive: true },
  freeipa: { ...area, root: "freeipa" },
  collabora: { url: "", internalUrl: "", wopiOrigin: "", documentFormat: "odf" },
  tokenConfigured: false,
  unreadable,
});

async function setup(unreadable: boolean, hold?: Promise<void>, activityRetentionDays?: number) {
  const dom = createDomTestHarness();
  const { default: Settings } = await import("./Settings");
  const { dialogCore } = await import("@k2b/ui");
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  let saved = 0;
  let dirty = { dirty: false, saving: false };
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: unknown, init?: RequestInit) => {
        requests.push({
          method: init?.method ?? "GET",
          url: String(input instanceof Request ? input.url : input),
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        });
        await hold;
        return Response.json({ reset: true });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  const dispose = render(
    () =>
      createComponent(Settings, {
        configuration: configuration(unreadable, activityRetentionDays),
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

// The history retention is one more stored key: the form sends it back unchanged and never saves a value the server refuses.
describe("Files settings history retention", () => {
  if (isServer) {
    test.skip("requires browser conditions and Solid DOM preload", () => {});
    return;
  }
  const type = (field: HTMLInputElement, value: string) => {
    field.value = value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  };

  test(
    "saving another field keeps a non-default retention",
    async () => {
      const ui = await setup(false, undefined, 90);
      try {
        const retention = ui.document.querySelector<HTMLInputElement>('input[name="activity-retention-days"]')!;
        expect(retention.value).toBe("90");
        type(ui.document.querySelector<HTMLInputElement>('input[name="filegate-url"]')!, "http://filegate:4000");
        await tick();
        ui.document.querySelector("form")!.requestSubmit();
        await tick();
        await tick();
        expect(ui.requests.map((request) => request.method)).toEqual(["PUT"]);
        expect(ui.requests[0]!.body).toMatchObject({ url: "http://filegate:4000", activityRetentionDays: 90 });
        expect(ui.saved()).toBe(1);
      } finally {
        ui.cleanup();
      }
    },
    TIMEOUT,
  );

  test(
    "29 and 3651 days are refused in place; a valid value is saved",
    async () => {
      const ui = await setup(false);
      try {
        const retention = ui.document.querySelector<HTMLInputElement>('input[name="activity-retention-days"]')!;
        for (const days of ["29", "3651"]) {
          type(retention, days);
          await tick();
          ui.document.querySelector("form")!.requestSubmit();
          await tick();
          expect(ui.requests).toEqual([]);
          const alerts = Array.from(ui.document.querySelectorAll('[role="alert"]')).map((alert) => alert.textContent?.trim());
          expect(alerts).toEqual(["Keep the history for 30 to 3,650 days."]);
        }
        type(retention, "400");
        await tick();
        expect(ui.document.querySelector('[role="alert"]')).toBeNull();
        ui.document.querySelector("form")!.requestSubmit();
        await tick();
        await tick();
        expect(ui.requests.map((request) => request.method)).toEqual(["PUT"]);
        expect(ui.requests[0]!.body).toMatchObject({ activityRetentionDays: 400 });
      } finally {
        ui.cleanup();
      }
    },
    TIMEOUT,
  );
});
