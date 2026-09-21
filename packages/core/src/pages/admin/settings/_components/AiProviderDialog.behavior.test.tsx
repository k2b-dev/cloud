import { describe, expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const profile = {
  id: "chat",
  label: "Test model",
  provider: "openai",
  model: "custom-chat-model",
  enabled: true,
  capabilities: ["streaming", "tools", "vision"],
  dataBoundary: "hosted",
  contextWindow: 32000,
  pricing: { inputPerMillion: 2, outputPerMillion: 8 },
};

async function setup() {
  const dom = createDomTestHarness();
  const { default: Form } = await import("./CoreSettingsForm.island");
  const { dialogCore } = await import("@k2b/ui");
  const requests: string[] = [];
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (_url: unknown, init?: RequestInit) => {
        if (typeof init?.body === "string") requests.push(init.body);
        return Response.json({ error: "test: inspect only, do not save" }, { status: 400 });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  const dispose = render(
    () =>
      createComponent(Form, {
        title: "Providers",
        subtitle: "",
        icon: "ti ti-sparkles",
        aiSection: "providers",
        aiAccountingUnit: "Credits",
        aiCredentialProfileIds: ["chat"],
        entries: [
          {
            key: "ai.model_profiles_json",
            label: "Models",
            description: "",
            kind: "text",
            value: JSON.stringify([profile]),
            default: "[]",
            resetValue: "[]",
            valueSource: "custom",
            resetValueSource: "default",
            isCustom: true,
            group: "ai",
          },
        ],
      }),
    dom.root,
  );
  const button = (text: string, root: ParentNode = dom.document) => {
    const found = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => !b.closest("[hidden]") && (b.textContent?.trim() === text || b.getAttribute("aria-label") === text),
    );
    if (!found) throw new Error(`Missing button: ${text}`);
    return found;
  };
  const input = (label: string) => {
    const field = Array.from(dom.document.querySelectorAll<HTMLLabelElement>("label")).find((l) => l.textContent?.trim() === label);
    if (!field) throw new Error(`Missing input: ${label}`);
    const control = field.htmlFor ? dom.document.getElementById(field.htmlFor) : field.querySelector("input");
    return control as HTMLInputElement;
  };
  const fill = (label: string, value: string) => {
    const field = input(label);
    field.value = value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("blur"));
  };
  const section = (name: string) => {
    const target = Array.from(dom.document.querySelectorAll("section")).find((s) => s.querySelector("h3")?.textContent === name);
    if (!target) throw new Error(`Missing section: ${name}`);
    if (target.getAttribute("data-open") !== "true") target.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!.click();
    return target;
  };
  const choose = async (label: string, option: string) => {
    const trigger = input(label);
    expect(trigger).not.toBeNull();
    trigger!.click();
    await tick();
    dom.document.querySelector<HTMLButtonElement>(`[role="option"][aria-label="${option}"]`)!.click();
    await tick();
  };
  button("Edit profile").click();
  await tick();
  return {
    ...dom,
    button,
    input,
    fill,
    section,
    choose,
    requests,
    dialogCore,
    cleanup: () => {
      dialogCore.close();
      dispose();
      fetch.mockRestore();
      dom.cleanup();
    },
  };
}

describe("Provider dialog", () => {
  if (isServer) {
    test.skip("requires browser conditions and Solid DOM preload", () => {});
    return;
  }
  test("accordion preserves edits, shows configured unit, and rejects partial prices in the cost section", async () => {
    const ui = await setup();
    try {
      ui.fill("Name", "Renamed model");
      ui.section("Costs");
      expect(ui.document.body.textContent).toContain("Credits");
      expect(ui.document.body.textContent).toContain("Example: 0.036 Credits");
      ui.fill("Output price per million tokens", "");
      ui.section("Access");
      ui.button("Apply to draft").click();
      await tick();
      expect(ui.dialogCore.isOpen()).toBe(true);
      expect(
        Array.from(ui.document.querySelectorAll("section"))
          .find((section) => section.querySelector("h3")?.textContent === "Costs")
          ?.getAttribute("data-open"),
      ).toBe("true");
      expect(ui.document.body.textContent).toContain("Enter both prices between");
      ui.fill("Output price per million tokens", "0");
      ui.fill("Input price per million tokens", "0");
      expect(ui.document.body.textContent).toContain("Free · both prices are zero");
      ui.section("Connection");
      expect(ui.input("Name").value).toBe("Renamed model");
      ui.button("Apply to draft").click();
      await tick();
      expect(ui.dialogCore.isOpen()).toBe(false);
      expect(ui.root.textContent).toContain("Renamed model");
      expect(ui.requests).toHaveLength(0);
    } finally {
      ui.cleanup();
    }
  });
  test("only chat and audio are usage choices; returning to chat retains image/tool capabilities", async () => {
    const ui = await setup();
    try {
      await ui.choose("Usage", "Audio transcription");
      ui.section("Costs");
      expect(ui.document.body.textContent).toContain("Audio transcription is not included in token pricing");
      expect(ui.document.querySelector('[role="switch"][aria-label="Set reference prices"]')).toBeNull();
      ui.section("Connection");
      await ui.choose("Usage", "Text / Chat");
      ui.section("Advanced");
      expect(ui.document.body.textContent).toContain("Streaming · Tools · Image analysis");
      ui.button("Cancel").click();
      await tick();
      expect(ui.root.textContent).toContain("Test model");
      expect(ui.requests).toHaveLength(0);
    } finally {
      ui.cleanup();
    }
  });
  test("output limit can be edited and cleared without losing unrelated profile settings", async () => {
    const ui = await setup();
    try {
      ui.section("Advanced");
      ui.fill("Default output limit (tokens)", "4096");
      ui.button("Apply to draft").click();
      await tick();
      ui.button("Edit profile").click();
      await tick();
      ui.section("Advanced");
      expect(ui.input("Default output limit (tokens)").value).toBe("4096");
      expect(ui.input("Context window").value).toBe("32000");
      ui.fill("Default output limit (tokens)", "");
      ui.button("Apply to draft").click();
      await tick();
      ui.button("Edit profile").click();
      await tick();
      ui.section("Advanced");
      expect(ui.input("Default output limit (tokens)").value).toBe("");
    } finally {
      ui.cleanup();
    }
  });
  test("turning reference prices off removes them from the draft without changing stored credentials", async () => {
    const ui = await setup();
    try {
      ui.section("Costs");
      ui.input("Set reference prices").click();
      expect(ui.document.body.textContent).toContain("The provider can still charge you");
      ui.button("Apply to draft").click();
      await tick();
      ui.button("Edit profile").click();
      await tick();
      ui.section("Costs");
      expect(ui.input("Set reference prices").checked).toBe(false);
      ui.section("Connection");
      expect(ui.input("OpenAI API key").value).toBe("");
      expect(ui.document.body.textContent).toContain("Key stored · leave empty to keep it.");
      expect(ui.requests).toHaveLength(0);
    } finally {
      ui.cleanup();
    }
  });
  test("audio ignores a hidden partial token price and stays unpriced when reopened", async () => {
    const ui = await setup();
    try {
      ui.section("Costs");
      ui.fill("Output price per million tokens", "");
      ui.section("Connection");
      await ui.choose("Usage", "Audio transcription");
      ui.fill("Model", "whisper-1");
      ui.button("Apply to draft").click();
      await tick();
      expect(ui.dialogCore.isOpen()).toBe(false);
      ui.button("Edit profile").click();
      await tick();
      ui.section("Costs");
      expect(ui.document.body.textContent).toContain("Audio · no cost accounting");
      ui.section("Connection");
      await ui.choose("Usage", "Text / Chat");
      ui.section("Costs");
      expect(ui.input("Set reference prices").checked).toBe(false);
      expect(ui.requests).toHaveLength(0);
    } finally {
      ui.cleanup();
    }
  });
  test("stored and draft key feedback stays accurate across repeated profile edits", async () => {
    const ui = await setup();
    try {
      expect(ui.input("Profile ID").closest("details")).toBeNull();
      expect(ui.document.body.textContent).toContain("Empty uses the provider default.");
      expect(ui.document.body.textContent).toContain("Key stored · leave empty to keep it.");
      ui.fill("OpenAI API key", "test-only-draft-key");
      expect(ui.document.body.textContent).toContain("New key in draft · not saved yet.");
      ui.button("Apply to draft").click();
      await tick();
      ui.button("Edit profile").click();
      await tick();
      expect(ui.input("OpenAI API key").value).toBe("");
      expect(ui.document.body.textContent).toContain("New key in draft · not saved yet.");
      ui.fill("Name", "Keep pending key");
      ui.button("Apply to draft").click();
      await tick();
      ui.button("Edit profile").click();
      await tick();
      expect(ui.document.body.textContent).toContain("New key in draft · not saved yet.");
      await ui.choose("Provider", "Anthropic");
      expect(ui.document.body.textContent).toContain("No key stored yet.");
      expect(ui.document.body.textContent).not.toContain("New key in draft · not saved yet.");
      expect(ui.requests).toHaveLength(0);
    } finally {
      ui.cleanup();
    }
  });
});
