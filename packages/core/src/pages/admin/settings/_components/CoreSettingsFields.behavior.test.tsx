import { describe, expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import type { SettingFieldDef } from "./CoreSettingsForm.island";

const fields = [
  { key: "geo.api_key", label: "Geoapify key", description: "Used only by the server.", kind: "secret", value: "" },
  {
    key: "geo.plan",
    label: "Geoapify plan",
    description: "Sets the provider request allowance.",
    kind: "enum",
    value: "free",
    options: [{ value: "free", label: "Free" }],
  },
  {
    key: "geo.person_daily_credits",
    label: "Daily credits per person",
    description: "Applies to people and service accounts.",
    kind: "number",
    value: 300,
    min: 0,
  },
] satisfies Pick<SettingFieldDef, "key" | "label" | "description" | "kind" | "value" | "options" | "min">[];

const entries: SettingFieldDef[] = fields.map((entry) => ({
  ...entry,
  default: entry.value,
  resetValue: entry.value,
  valueSource: "default",
  resetValueSource: "default",
  isCustom: false,
  unreadable: false,
  group: "geo",
}));

describe("generic core setting field semantics", () => {
  if (isServer) {
    test.skip("requires browser conditions and Solid DOM preload", () => {});
    return;
  }

  test("names each control and keeps its description when a save adds a field error", async () => {
    const dom = createDomTestHarness();
    const { default: Form } = await import("./CoreSettingsForm.island");
    const { dialogCore } = await import("@k2b/ui");
    const message = "The daily limit must not exceed the monthly budget.";
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(async () => Response.json({ message: "Not saved", errors: { "geo.person_daily_credits": message } }, { status: 400 }), {
        preconnect: globalThis.fetch.preconnect,
      }),
    );
    const dispose = render(
      () => createComponent(Form, { title: "Places and addresses", subtitle: "", icon: "ti ti-map-pin", entries }),
      dom.root,
    );
    const descriptions = (control: Element) =>
      (control.getAttribute("aria-describedby") ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => dom.document.getElementById(id)?.textContent?.trim());
    try {
      for (const entry of entries) {
        const control = dom.root.querySelector(`[aria-label="${entry.label}"]`);
        expect(control).not.toBeNull();
        expect(descriptions(control!)).toContain(entry.description);
      }

      const input = dom.root.querySelector<HTMLInputElement>('input[aria-label="Daily credits per person"]')!;
      input.value = "95000";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const save = Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.trim() === "Save changes",
      )!;
      expect(save.disabled).toBe(false);
      save.click();
      for (let attempt = 0; attempt < 100 && input.getAttribute("aria-invalid") !== "true"; attempt++) {
        await Bun.sleep(10);
      }
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(descriptions(input)).toEqual([entries[2]!.description, message]);
      expect(input.value).toBe("95000");
    } finally {
      dialogCore.close();
      dispose();
      fetch.mockRestore();
      dom.cleanup();
    }
  }, 20_000);
});
