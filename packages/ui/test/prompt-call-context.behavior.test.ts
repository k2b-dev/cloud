import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "./dom";

// A prompt whose code loads first keeps the context of its call: the palette of the area that asked, the page it was
// asked on, and the control focus returns to. WebKit does not focus a clicked button, so focus can be anywhere by the
// time the code arrives.

/** Waits for a condition; the test's own timeout bounds it. */
const until = async (ready: () => boolean) => {
  while (!ready()) await Bun.sleep(10);
};

type Deferred = { promise: Promise<unknown>; resolve: () => void };
const loads: Deferred[] = [];
/** The form's field chunk, held back until the test lets it arrive. */
const formModule = {
  PromptFormDialog: () => {
    const form = document.createElement("form");
    form.className = "k2b-dialog__panel";
    form.innerHTML = '<div class="k2b-dialog__body"><input aria-label="Name"></div>';
    return form;
  },
  TextInput: (props: { ref?: (element: HTMLInputElement) => void }) => {
    const input = document.createElement("input");
    props.ref?.(input);
    return input;
  },
};

describe("@k2b/ui prompts whose code loads on demand", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  let dom: DomTestHarness;
  let phone = false;
  let ui: { prompts: typeof import("../src/feedback/prompts").prompts; dialogCore: typeof import("../src/feedback/dialog-core").dialogCore };
  beforeAll(async () => {
    // One window for the file: the shared dialog core listens to the window it was created in.
    dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    Object.defineProperty(globalThis, "matchMedia", {
      configurable: true,
      value: (query: string) => ({ matches: phone && query.includes("max-width"), media: query }),
    });
    mock.module("../src/feedback/prompt-form-loader", () => ({
      loadedPromptForm: () => undefined,
      loadPromptForm: () => {
        let resolve = () => {};
        const promise = new Promise((done) => (resolve = () => done(formModule)));
        loads.push({ promise, resolve });
        return promise;
      },
    }));
    const { dialogCore } = await import("../src/feedback/dialog-core");
    const { prompts } = await import("../src/feedback/prompts");
    ui = { prompts, dialogCore };
  });
  afterEach(() => {
    ui.dialogCore.close();
    loads.length = 0;
    phone = false;
    for (const element of [...dom.root.children]) element.remove();
  });

  const dialog = () => dom.document.querySelector<HTMLDialogElement>("dialog[open]");
  /** An AI-coloured area with its trigger, and a plain control elsewhere on the page. */
  const page = () => {
    const area = dom.document.createElement("section");
    area.dataset.k2bPrimary = "ai";
    const trigger = dom.document.createElement("button");
    area.append(trigger);
    const elsewhere = dom.document.createElement("button");
    dom.root.append(area, elsewhere);
    return { trigger, elsewhere };
  };
  const navigate = () =>
    dom.window.dispatchEvent(new dom.window.CustomEvent("ssr:island-dispose", { bubbles: true, detail: { id: "page" } }) as unknown as Event);
  const arrive = async () => {
    for (const load of loads) load.resolve();
    await Promise.all(loads.map((load) => load.promise));
  };

  for (const kind of ["form", "typed confirmation"] as const) {
    const ask = () =>
      kind === "form"
        ? ui.prompts.form({ title: "Rename", fields: { name: { type: "text", label: "Name" } } })
        : ui.prompts.confirm("Delete the space?", { title: "Delete", confirmationPhrase: "Studio" });

    test(`a ${kind} opens with the palette of its call and returns focus to its opener`, async () => {
      const { trigger, elsewhere } = page();
      trigger.focus();
      const result = ask();
      elsewhere.focus();
      await arrive();
      await until(() => dialog() !== null);
      expect(dialog()?.dataset.k2bPrimary).toBe("ai");
      ui.dialogCore.close();
      await result;
      await Bun.sleep(50);
      expect(dom.document.activeElement === trigger).toBe(true);
    });

    test(`a ${kind} asked before a navigation does not open over the new page`, async () => {
      const { trigger } = page();
      trigger.focus();
      const result = ask();
      navigate();
      await arrive();
      expect(await result).toBe(kind === "form" ? null : undefined);
      expect(dialog()).toBeNull();
    });
  }

  test("a phone sheet keeps the palette of its call, and one asked before a navigation stays closed", async () => {
    phone = true;
    const { trigger, elsewhere } = page();
    // Both prompts wait for the sheet's code, which has not loaded yet.
    const before = ui.prompts.alert("Saved before the page changed", { title: "Before" });
    navigate();
    trigger.focus();
    const after = ui.prompts.alert("Saved", { title: "After" });
    elsewhere.focus();
    await until(() => dialog() !== null);
    expect(dialog()?.getAttribute("aria-label")).toBe("After");
    expect(dialog()?.classList.contains("k2b-prompt-sheet")).toBe(true);
    expect(dialog()?.dataset.k2bPrimary).toBe("ai");
    expect(await before).toBeUndefined();
    ui.dialogCore.close();
    await after;
    await Bun.sleep(50);
    expect(dom.document.activeElement === trigger).toBe(true);
  });
});
