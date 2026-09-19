import { expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import type { WorkflowRunInputDraft } from "./workflow-trigger-actions";

test("decimal workflow controls show German values and preserve exact text while typing", async () => {
  const dom = createDomTestHarness();
  const { LocaleProvider } = await import("@k2b/ui");
  const { WorkflowInputFields } = await import("./WorkflowInputFields");
  const [draft, setDraft] = createSignal<WorkflowRunInputDraft>({ amount: "9007199254740993.25" });
  const dispose = render(
    () =>
      createComponent(LocaleProvider, {
        locale: "de-DE",
        get children() {
          return createComponent(WorkflowInputFields, {
            workflow: {
              plan: { inputs: [{ name: "amount", type: "decimal", config: { label: "Betrag", required: true } }], bindings: {} },
            },
            tables: [],
            draft,
            onValueChange: (name, value) => setDraft({ ...draft(), [name]: value }),
          });
        },
      }),
    dom.root,
  );
  try {
    const input = dom.root.querySelector<HTMLInputElement>("input")!;
    expect(input.value).toBe("9007199254740993,25");
    expect(input.inputMode).toBe("decimal");
    input.value = "9007199254740993,35";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(draft().amount).toBe("9007199254740993.35");
    expect(input.value).toBe("9007199254740993,35");
  } finally {
    dispose();
    dom.cleanup();
  }
});
