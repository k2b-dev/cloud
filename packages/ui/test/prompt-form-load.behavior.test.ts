import { describe, expect, mock, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "./dom";

/** Waits for the prompt to appear; the test's own timeout bounds it. */
const until = async (ready: () => boolean) => {
  while (!ready()) await Bun.sleep(10);
};

describe("@k2b/ui form prompt loading", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("a form or a typed confirmation cancelled while its fields load opens nothing", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    mock.module("../src/feedback/prompt-form", () => {
      throw new Error("The chunk request failed");
    });
    const { prompts } = await import("../src/feedback/prompts");
    const opened: string[] = [];
    const watch = new MutationObserver(() => {
      for (const dialog of dom.document.querySelectorAll("dialog[open]")) opened.push(dialog.getAttribute("aria-label") ?? "");
    });
    watch.observe(dom.document.body, { subtree: true, childList: true, attributes: true });
    const cancel = new AbortController();
    const form = prompts.form({ title: "Rename", fields: { name: { type: "text", label: "Name" } }, signal: cancel.signal });
    const phrase = prompts.confirm("Delete the space?", { confirmationPhrase: "Studio", signal: cancel.signal });
    cancel.abort();
    expect(await form).toBeNull();
    expect(await phrase).toBe(false);
    watch.disconnect();
    expect(opened).toEqual([]);
    dom.cleanup();
  });

  test("a typed confirmation whose field fails to load says so and does not confirm", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    mock.module("../src/feedback/prompt-form", () => {
      throw new Error("The chunk request failed");
    });
    const { dialogCore } = await import("../src/feedback/dialog-core");
    const { prompts } = await import("../src/feedback/prompts");
    const dialog = () => dom.document.querySelector<HTMLDialogElement>("dialog[open]");
    const confirmed = prompts.confirm("Delete the space?", { confirmationPhrase: "Studio" });
    await until(() => dialog() !== null);
    expect(dialog()?.getAttribute("aria-label")).toBe("Error");
    dialogCore.close();
    expect(await confirmed).toBe(false);
    dom.cleanup();
  });

  test("a form whose fields fail to load says so, and the next open loads them again", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    mock.module("../src/feedback/prompt-form", () => {
      throw new Error("The chunk request failed");
    });
    const { dialogCore } = await import("../src/feedback/dialog-core");
    const { prompts } = await import("../src/feedback/prompts");
    const dialog = () => dom.document.querySelector<HTMLDialogElement>("dialog[open]");

    const failed = prompts.form({ title: "Rename", fields: { name: { type: "text", label: "Name" } } });
    await until(() => dialog() !== null);
    expect(dialog()?.getAttribute("aria-label")).toBe("Error");
    expect(dialog()?.querySelector(".k2b-dialog__body")?.textContent).toBe("The form could not load. Check the connection and try again.");
    dialogCore.close();
    expect(await failed).toBeNull();

    // The connection is back. A stand-in form arrives, since this test is about the loading, not the fields.
    mock.module("../src/feedback/prompt-form", () => ({
      PromptFormDialog: () => {
        const form = document.createElement("form");
        form.className = "k2b-dialog__panel";
        form.innerHTML = '<div class="k2b-dialog__body"><input aria-label="Name"></div>';
        return form;
      },
    }));
    // The form opens once its fields are there, fully drawn: the first open frame already holds the field.
    const firstOpen: boolean[] = [];
    const watch = new MutationObserver(() => {
      const shown = dialog();
      if (shown && firstOpen.length === 0) firstOpen.push(shown.querySelector(".k2b-dialog__body input") !== null);
    });
    watch.observe(dom.document.body, { subtree: true, childList: true, attributes: true });
    const retried = prompts.form({ title: "Rename", fields: { name: { type: "text", label: "Name" } } });
    await until(() => dialog()?.querySelector(".k2b-dialog__body input") != null);
    watch.disconnect();
    expect(firstOpen).toEqual([true]);
    expect(dialog()?.getAttribute("aria-label")).toBe("Rename");
    dialogCore.close();
    expect(await retried).toBeNull();

    dom.cleanup();
  });
});
