import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import type { SettingFieldDef } from "./CoreSettingsForm.island";

const entry: SettingFieldDef = {
  key: "mail.invite_template",
  label: "Invitation",
  description: "Sent when someone is invited.",
  kind: "template",
  value: "<p>Hello {{ name }}</p>",
  default: "",
  resetValue: "",
  valueSource: "custom",
  resetValueSource: "default",
  isCustom: true,
  unreadable: false,
  group: "mail",
  templateVars: ["name"],
};

describe("core template setting editor", () => {
  if (isServer) {
    test.skip("requires browser conditions and Solid DOM preload", () => {});
    return;
  }

  test("opens movable panes in a 2 px field edge instead of a grey box, with a fixed boundary", async () => {
    const dom = createDomTestHarness();
    const { FieldInput } = await import("./setting-inputs");
    const { dialogCore } = await import("@k2b/ui");
    const dispose = render(
      () => createComponent(FieldInput, { entry, value: () => entry.value, error: () => undefined, onChange: () => undefined }),
      dom.root,
    );
    try {
      const edit = Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
        button.textContent?.includes("Edit template"),
      )!;
      edit.click();
      let panes: Element | null = null;
      for (let attempt = 0; attempt < 100 && !panes; attempt++) {
        await Bun.sleep(10);
        panes = dom.document.querySelector("[data-k2b-panes]");
      }
      expect(panes).not.toBeNull();
      const frame = panes!.parentElement!;
      expect(frame.className).toContain("border-2");
      expect(frame.className).not.toContain("bg-zinc-100");
      expect(panes!.querySelectorAll(".k2b-panes__grip").length).toBe(3);
      expect(panes!.querySelectorAll(".k2b-panes__arrange").length).toBe(1);
      expect(panes!.querySelector('[role="separator"]')?.getAttribute("aria-disabled")).toBe("true");
    } finally {
      dialogCore.close();
      dispose();
      dom.cleanup();
    }
  }, 20_000);
});
