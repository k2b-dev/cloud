import { describe, expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import type { SettingFieldDef } from "./CoreSettingsForm.island";

const instructions: SettingFieldDef = {
  key: "ai.global_instructions",
  label: "Global instructions",
  description: "",
  kind: "text",
  value: "Original instructions",
  default: "",
  resetValue: "",
  valueSource: "custom",
  resetValueSource: "default",
  isCustom: true,
  unreadable: false,
  group: "ai",
  updatedAt: "2026-10-16T00:00:00.000Z",
};

describe("AI settings save errors", () => {
  if (isServer) {
    test.skip("requires browser conditions and Solid DOM preload", () => {});
    return;
  }
  test("a rejected save preserves the instructions and sends the observed version", async () => {
    const dom = createDomTestHarness();
    const { default: Form } = await import("./CoreSettingsForm.island");
    const { dialogCore } = await import("@k2b/ui");
    const requests: unknown[] = [];
    const message = "Instructions could not be saved. Try again.";
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (_url: unknown, init?: RequestInit) => {
          if (typeof init?.body === "string") requests.push(JSON.parse(init.body));
          return Response.json({ message, errors: { [instructions.key]: message } }, { status: 400 });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const dispose = render(
      () =>
        createComponent(Form, {
          title: "AI",
          subtitle: "",
          icon: "ti ti-sparkles",
          aiSection: "general",
          entries: [instructions],
        }),
      dom.root,
    );
    try {
      const field = dom.document.querySelector<HTMLTextAreaElement>("textarea");
      if (!field) throw new Error("Missing instructions field");
      field.value = "Keep this draft";
      field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "Keep this draft" }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const save = Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.trim() === "Save changes",
      );
      if (!save) throw new Error("Missing save button");
      save.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(requests).toEqual([
        {
          updates: { "ai.global_instructions": "Keep this draft" },
          resets: [],
          replaceUnreadable: [],
          expectedUpdatedAt: { "ai.global_instructions": instructions.updatedAt },
        },
      ]);
      expect(field.value).toBe("Keep this draft");
      expect(dom.document.body.textContent).toContain(message);
      expect(save.disabled).toBe(false);
    } finally {
      dialogCore.close();
      dispose();
      fetch.mockRestore();
      dom.cleanup();
    }
  }, 20_000);
});
