import { describe, expect, test } from "bun:test";
import { createDialogCore } from "../src/feedback/dialog-core";
import { createDomTestHarness } from "./dom";

const settle = () => Bun.sleep(10);

describe("guarded dialog dismissal", () => {
  test("Escape and backdrop preserve state until the registered handler closes", async () => {
    const dom = createDomTestHarness();
    const core = createDialogCore();
    let allowed = false;
    let calls = 0;
    const result = core.open<string>((close, context) => {
      context.setDismissHandler(() => {
        calls++;
        if (allowed) close("discarded");
      });
      return document.createElement("input");
    });
    const dialog = dom.document.querySelector("dialog")!;
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    await settle();
    expect(core.isOpen()).toBe(true);
    expect(calls).toBe(1);
    allowed = true;
    dialog.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(await result).toBe("discarded");
    expect(calls).toBe(2);
    dom.cleanup();
  });

  test("nested confirmation cancellation restores the parent's guard", async () => {
    const dom = createDomTestHarness();
    const core = createDialogCore();
    let confirm: (result?: boolean) => void = () => {};
    let calls = 0;
    const result = core.open((close, context) => {
      context.setDismissHandler(async () => {
        calls++;
        const accepted = await core.open<boolean>((closeConfirmation) => {
          confirm = closeConfirmation;
          return document.createElement("button");
        });
        if (accepted) close();
      });
      return document.createElement("input");
    });
    const dialog = dom.document.querySelector("dialog")!;
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    confirm(false);
    await settle();
    expect(core.isOpen()).toBe(true);
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(calls).toBe(2);
    confirm(true);
    await result;
    expect(core.isOpen()).toBe(false);
    dom.cleanup();
  });

  test("coalesces pending dismissal and leaves completion callbacks unguarded", async () => {
    const dom = createDomTestHarness();
    const core = createDialogCore();
    let finish: () => void = () => {};
    let release: () => void = () => {};
    let calls = 0;
    const result = core.open((close, context) => {
      finish = close;
      context.setDismissHandler(async () => {
        calls++;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      return document.createElement("input");
    });
    const dialog = dom.document.querySelector("dialog")!;
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(calls).toBe(1);
    finish();
    await result;
    release();
    await settle();
    expect(core.isOpen()).toBe(false);
    dom.cleanup();
  });
});

const forceNativeClose = (dialog: HTMLDialogElement) => {
  dialog.dispatchEvent(new Event("cancel", { cancelable: false }));
  dialog.removeAttribute("open");
  dialog.dispatchEvent(new Event("close"));
};

test("forced native close preserves guards, focus, scroll and reopening", async () => {
  const dom = createDomTestHarness();
  const core = createDialogCore();
  const opener = document.createElement("button");
  dom.root.append(opener);
  opener.focus();
  let allowed = false;
  const result = core.open((close, context) => {
    context.setDismissHandler(() => { if (allowed) close(); });
    const input = document.createElement("input");
    input.value = "unsaved value";
    return input;
  });
  const dialog = dom.document.querySelector("dialog")!;
  forceNativeClose(dialog);
  expect(dialog.open).toBe(true);
  expect(dialog.querySelector("input")?.value).toBe("unsaved value");
  expect(document.body.style.overflow).toBe("hidden");
  await settle();
  allowed = true;
  dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
  await result;
  await settle();
  expect(core.isOpen()).toBe(false);
  expect(document.body.style.overflow).toBe("");
  expect(document.activeElement).toBe(opener);
  const reopened = core.open(() => document.createElement("input"));
  expect(dom.document.querySelector("dialog")?.open).toBe(true);
  dialog.dispatchEvent(new Event("close"));
  expect(dom.document.querySelector("dialog")?.open).toBe(true);
  core.close();
  await reopened;
  dom.cleanup();
});

test("forced native close restores a parent after dismissing its child", async () => {
  const dom = createDomTestHarness();
  const core = createDialogCore();
  const parent = core.open(() => document.createTextNode("Parent"));
  const child = core.open(() => document.createTextNode("Child"));
  const dialog = dom.document.querySelector("dialog")!;
  forceNativeClose(dialog);
  await child;
  expect(dialog.open).toBe(true);
  expect(dialog.textContent).toBe("Parent");
  core.close();
  await parent;
  dom.cleanup();
});

test("ignore keeps its content after forced native close", async () => {
  const dom = createDomTestHarness();
  const core = createDialogCore();
  const result = core.open(() => document.createTextNode("Keep me"), { cancelBehavior: "ignore" });
  const dialog = dom.document.querySelector("dialog")!;
  forceNativeClose(dialog);
  expect(dialog.open).toBe(true);
  expect(core.isOpen()).toBe(true);
  expect(dialog.textContent).toBe("Keep me");
  core.close();
  await result;
  dom.cleanup();
});
