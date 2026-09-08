import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";

describe("AI task prompt viewer", () => {
  if (isServer) {
    test.skip("requires browser conditions and Solid DOM preload", () => {});
    return;
  }
  test("opens both personalization prompts read-only without saving settings", async () => {
    const dom = createDomTestHarness();
    const { default: Form } = await import("./CoreSettingsForm.island");
    const { dialogCore } = await import("@k2b/ui");
    const dispose = render(
      () =>
        createComponent(Form, {
          title: "Background jobs",
          subtitle: "",
          icon: "ti ti-activity",
          aiSection: "jobs",
          entries: [
            {
              key: "ai.model_profiles_json",
              label: "Models",
              description: "",
              kind: "text",
              value: "[]",
              default: "[]",
              resetValue: "[]",
              valueSource: "default",
              resetValueSource: "default",
              isCustom: false,
              group: "ai",
            },
          ],
          backgroundTaskPrompts: { "ai.memory_learning_instructions": ["Original turn learning prompt", "Original workflow prompt"] },
        }),
      dom.root,
    );
    try {
      const button = Array.from(dom.root.querySelectorAll("button")).find((item) => item.textContent === "View built-in prompts");
      expect(button).toBeDefined();
      expect(button?.type).toBe("button");
      button!.click();
      expect(dialogCore.isOpen()).toBe(true);
      expect(dom.document.body.textContent).toContain("Original turn learning prompt");
      expect(dom.document.body.textContent).toContain("Original workflow prompt");
      const dialog = dom.document.querySelector('dialog, [role="dialog"]');
      expect(dialog?.querySelectorAll("textarea, input").length).toBe(0);
      dialogCore.close();
      expect(dialogCore.isOpen()).toBe(false);
    } finally {
      dialogCore.close();
      dispose();
      dom.cleanup();
    }
  });
});
