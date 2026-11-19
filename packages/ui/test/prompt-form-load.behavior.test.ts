import { describe, expect, mock, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "./dom";

/** Waits a bounded number of frames for the prompt to appear. */
const until = async (ready: () => boolean) => {
  for (let frame = 0; frame < 100 && !ready(); frame++) await Bun.sleep(10);
  expect(ready()).toBe(true);
};

describe("@k2b/ui form prompt loading", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

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
    const retried = prompts.form({ title: "Rename", fields: { name: { type: "text", label: "Name" } } });
    await until(() => dialog()?.querySelector(".k2b-dialog__body input") != null);
    expect(dialog()?.getAttribute("aria-label")).toBe("Rename");
    dialogCore.close();
    expect(await retried).toBeNull();

    dom.cleanup();
  });
});
