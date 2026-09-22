import { describe, expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import type { SettingFieldDef } from "./CoreSettingsForm.island";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
// The first test pays for loading the whole settings island.
const TIMEOUT = 20_000;
const profile = (id: string, label: string) => ({
  id,
  label,
  provider: "ollama",
  model: id,
  enabled: true,
  capabilities: ["streaming", "vision"],
  dataBoundary: "private",
});
const entry = (key: string, value: unknown): SettingFieldDef => ({
  key,
  label: key,
  description: "",
  kind: key === "ai.enabled" ? "boolean" : key === "ai.model_profiles_json" ? "text" : "string",
  value,
  default: "",
  resetValue: "",
  valueSource: "custom",
  resetValueSource: "default",
  isCustom: true,
  group: "ai",
});
// The body the settings route returns when the Vision model still uses a removed profile.
const visionMessage =
  "The Vision tool model still references “TensorX Standard”. Select another Vision tool model or disable the view_image fallback before removing this profile.";
const rejection = {
  message: "The AI settings were not saved. Resolve the problems below and save again.",
  errors: { "ai.vision_model_id": visionMessage },
  issues: [{ code: "model_profile_missing", setting: "ai.vision_model_id", profileId: "tensorx", message: visionMessage }],
};

async function setup(aiSection: "general" | "providers") {
  const dom = createDomTestHarness();
  const { default: Form } = await import("./CoreSettingsForm.island");
  const { dialogCore } = await import("@k2b/ui");
  const requests: string[] = [];
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (_url: unknown, init?: RequestInit) => {
        if (typeof init?.body === "string") requests.push(init.body);
        return Response.json(rejection, { status: 400 });
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
        aiSection,
        entries: [
          entry("ai.enabled", true),
          entry("ai.default_model_id", "cortecs"),
          entry("ai.vision_model_id", "tensorx"),
          entry("ai.model_profiles_json", JSON.stringify([profile("tensorx", "TensorX Standard"), profile("cortecs", "Cortecs")])),
        ],
      }),
    dom.root,
  );
  const button = (text: string) => {
    const found = Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => !b.closest("[hidden]") && (b.textContent?.trim() === text || b.getAttribute("aria-label") === text),
    );
    if (!found) throw new Error(`Missing button: ${text}`);
    return found;
  };
  const notice = () => dom.document.querySelector<HTMLElement>('.k2b-notice-card[data-tone="danger"]');
  await tick();
  return {
    ...dom,
    button,
    notice,
    requests,
    cleanup: () => {
      dialogCore.close();
      dispose();
      fetch.mockRestore();
      dom.cleanup();
    },
  };
}

describe("AI settings save errors", () => {
  if (isServer) {
    test.skip("requires browser conditions and Solid DOM preload", () => {});
    return;
  }

  test(
    "removing a profile the Vision model uses explains the blocker and keeps the draft",
    async () => {
      const ui = await setup("providers");
      try {
        const { dialogCore } = await import("@k2b/ui");
        ui.button("Remove profile").click();
        await tick();
        ui.button("Remove").click();
        await tick();
        ui.button("Save changes").click();
        await tick();
        await tick();

        expect(JSON.parse(ui.requests[0]!)["ai.model_profiles_json"]).not.toContain("tensorx");
        const notice = ui.notice();
        expect(notice).not.toBeNull();
        expect(notice!.textContent).toContain(rejection.message);
        expect(notice!.querySelector('[data-setting="ai.vision_model_id"]')?.textContent).toContain(`Vision tool model${visionMessage}`);
        const link = notice!.querySelector<HTMLAnchorElement>('a[href="/admin/settings?tab=ai-general"]');
        expect(link?.textContent?.trim()).toBe("Open AI general");
        // No modal on top of the summary, and the removal stays staged.
        expect(dialogCore.isOpen()).toBe(false);
        expect(ui.document.activeElement).toBe(notice);
        expect(ui.document.querySelector("table")?.textContent).not.toContain("TensorX Standard");
        expect(ui.document.querySelector("table")?.textContent).toContain("Cortecs");
        expect(ui.button("Save changes").disabled).toBe(false);
      } finally {
        ui.cleanup();
      }
    },
    TIMEOUT,
  );

  test(
    "marks and focuses the rejected field when it is on the current page",
    async () => {
      const ui = await setup("general");
      try {
        const vision = ui.document.getElementById("setting-ai-vision_model_id") as HTMLButtonElement;
        vision.click();
        await tick();
        ui.document.querySelector<HTMLButtonElement>('[role="option"][id^="setting-ai-vision_model_id-"][aria-label="Cortecs"]')!.click();
        await tick();
        ui.button("Save changes").click();
        await tick();
        await tick();

        expect(vision.getAttribute("aria-invalid")).toBe("true");
        expect(ui.document.getElementById(vision.getAttribute("aria-describedby")!.split(" ").at(-1)!)?.textContent).toBe(visionMessage);
        expect(ui.document.activeElement).toBe(vision);
        expect(ui.notice()?.textContent).toContain("Go to field");
      } finally {
        ui.cleanup();
      }
    },
    TIMEOUT,
  );
});
