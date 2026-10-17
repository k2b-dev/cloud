import { describe, expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import type { SettingFieldDef } from "./CoreSettingsForm.island";

// #1303: a stored row this application cannot read is shown as such, and only an explicit edit or reset replaces it.
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const TIMEOUT = 20_000;
const entry = (key: string, label: string, value: string, unreadable: boolean): SettingFieldDef => ({
  key,
  label,
  description: "",
  kind: "string",
  value,
  default: "Cloud",
  resetValue: "Cloud",
  valueSource: unreadable ? "default" : "custom",
  resetValueSource: "default",
  isCustom: true,
  unreadable,
  group: "app",
});

async function setup() {
  const dom = createDomTestHarness();
  const { default: Form } = await import("./CoreSettingsForm.island");
  const requests: unknown[] = [];
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (_url: unknown, init?: RequestInit) => {
        if (typeof init?.body === "string") requests.push(JSON.parse(init.body));
        // A rejection keeps the page in place instead of reloading it.
        return Response.json({ message: "Not saved", errors: {} }, { status: 400 });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  const dispose = render(
    () =>
      createComponent(Form, {
        title: "General",
        subtitle: "",
        icon: "ti ti-settings",
        entries: [entry("app.name", "Cloud name", "Cloud", true), entry("app.contact_email", "Contact", "team@example.org", false)],
      }),
    dom.root,
  );
  const buttons = (text: string) =>
    Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).filter(
      (b) => b.textContent?.trim() === text || b.getAttribute("aria-label") === text,
    );
  const type = async (placeholder: string, value: string) => {
    const input = dom.document.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`);
    if (!input) throw new Error(`Missing input: ${placeholder}`);
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
  };
  const save = async () => {
    buttons("Save changes")[0]!.click();
    await tick();
    await tick();
  };
  await tick();
  const { dialogCore } = await import("@k2b/ui");
  return {
    ...dom,
    buttons,
    type,
    save,
    requests,
    cleanup: () => {
      dialogCore.close();
      dispose();
      fetch.mockRestore();
      dom.cleanup();
    },
  };
}

describe("unreadable stored settings", () => {
  if (isServer) {
    test.skip("requires browser conditions and Solid DOM preload", () => {});
    return;
  }

  test(
    "the page names the unreadable setting and marks its row",
    async () => {
      const ui = await setup();
      try {
        const notice = ui.document.querySelector<HTMLElement>('.k2b-notice-card[data-tone="warning"]');
        expect(notice?.textContent).toContain("A stored setting cannot be read");
        expect(notice?.textContent).toContain("APP_SECRET");
        expect(notice?.querySelector('[data-setting="app.name"]')?.textContent).toContain("Cloud name");
        expect(notice?.querySelector('[data-setting="app.contact_email"]')).toBeNull();
        const badges = Array.from(ui.document.querySelectorAll(".k2b-status-badge")).map((badge) => badge.textContent?.trim());
        expect(badges).toEqual(["Unreadable"]);
      } finally {
        ui.cleanup();
      }
    },
    TIMEOUT,
  );

  test(
    "entering a new value replaces the unreadable row explicitly; other edits do not",
    async () => {
      const ui = await setup();
      try {
        await ui.type("Contact", "help@example.org");
        await ui.save();
        expect(ui.requests.at(-1)).toEqual({ "app.contact_email": "help@example.org" });

        await ui.type("Cloud name", "Example Cloud");
        await ui.save();
        expect(ui.requests.at(-1)).toEqual({
          updates: { "app.name": "Example Cloud", "app.contact_email": "help@example.org" },
          resets: [],
          replaceUnreadable: ["app.name"],
        });
      } finally {
        ui.cleanup();
      }
    },
    TIMEOUT,
  );

  test(
    "use default in the notice stages the reset and stays in place",
    async () => {
      const ui = await setup();
      try {
        const [inNotice] = ui.buttons("Use default for Cloud name");
        expect(inNotice?.closest(".k2b-notice-card")).not.toBeNull();
        inNotice!.click();
        await tick();
        expect(ui.buttons("Use default for Cloud name").every((button) => button.disabled)).toBe(true);
        await ui.save();
        expect(ui.requests.at(-1)).toEqual({ updates: {}, resets: ["app.name"], replaceUnreadable: [] });
      } finally {
        ui.cleanup();
      }
    },
    TIMEOUT,
  );
});
