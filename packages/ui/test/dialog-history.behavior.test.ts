import { afterEach, describe, expect, test } from "bun:test";
import { createDialogCore } from "../src/feedback/dialog-core";
import { createDomTestHarness, type DomTestHarness } from "./dom";

let dom: DomTestHarness;
afterEach(() => dom.cleanup());

const popped = () => new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
const settle = () => Bun.sleep(20);
const marker = () => (history.state as { k2bDialog?: number } | null)?.k2bDialog;
const view = (text: string) => () => {
  const element = document.createElement("p");
  element.textContent = text;
  return element;
};

describe("dialogCore history option", () => {
  test("Back closes the dialog instead of leaving the page", async () => {
    dom = createDomTestHarness();
    const core = createDialogCore();
    const start = history.length;
    const result = core.open(view("Sheet"), { history: true });
    expect(history.length).toBe(start + 1);
    expect(marker()).toBeNumber();
    const back = popped();
    history.back();
    await back;
    expect(await result).toBeUndefined();
    expect(core.isOpen()).toBe(false);
    expect(marker()).toBeUndefined();
    expect(location.href).toBe("http://localhost/");
  });

  test("closing removes the entry again before the promise settles", async () => {
    dom = createDomTestHarness();
    const core = createDialogCore();
    const result = core.open<string>(
      (close) => {
        queueMicrotask(() => close("done"));
        return document.createElement("p");
      },
      { history: true },
    );
    expect(await result).toBe("done");
    expect(marker()).toBeUndefined();
  });

  test("Back closes only the newest of nested dialogs, and everything opened after it", async () => {
    dom = createDomTestHarness();
    const core = createDialogCore();
    const outer = core.open(view("Outer"), { history: true });
    const inner = core.open(view("Inner"), { history: true });
    const confirmation = core.open(view("Confirm"));
    let back = popped();
    history.back();
    await back;
    expect(await inner).toBeUndefined();
    expect(await confirmation).toBeUndefined();
    expect(core.isOpen()).toBe(true);
    expect(document.querySelector("dialog")?.textContent).toBe("Outer");
    back = popped();
    history.back();
    await back;
    expect(await outer).toBeUndefined();
    expect(core.isOpen()).toBe(false);
  });

  test("closing every dialog returns to the page in one step, and the next dialog waits for it", async () => {
    dom = createDomTestHarness();
    const core = createDialogCore();
    const start = history.length;
    const first = core.open(view("First"), { history: true });
    const second = core.open(view("Second"), { history: true });
    core.close();
    const next = core.open(view("Next"), { history: true });
    expect(core.isOpen()).toBe(false);
    await Promise.all([first, second]);
    await settle();
    // Both closed entries left in one step; only the next dialog's entry is above the page.
    expect(core.isOpen()).toBe(true);
    expect(document.querySelector("dialog")?.textContent).toBe("Next");
    expect(history.length).toBe(start + 1);
    expect(marker()).toBeNumber();
    const back = popped();
    history.back();
    await back;
    await next;
    expect(core.isOpen()).toBe(false);
    expect(marker()).toBeUndefined();
  });

  test("a reloaded page drops a stale dialog marker instead of reopening on Forward", async () => {
    dom = createDomTestHarness();
    history.replaceState({ k2bDialog: 41, page: "tasks" }, "");
    const core = createDialogCore();
    const result = core.open(view("Sheet"), { history: true });
    const back = popped();
    history.back();
    await back;
    await result;
    expect(history.state).toEqual({ page: "tasks" });
  });

  test("dialogs without the option leave the history alone", async () => {
    dom = createDomTestHarness();
    const core = createDialogCore();
    const start = history.length;
    const result = core.open(view("Plain"));
    expect(history.length).toBe(start);
    core.close();
    await result;
    expect(history.length).toBe(start);
  });

  test("prompts take the option, and Back dismisses them", async () => {
    dom = createDomTestHarness();
    const { prompts } = await import("../src/feedback/prompts");
    const start = history.length;
    const answer = prompts.confirm("Sign out of the app?", { history: true });
    expect(history.length).toBe(start + 1);
    const back = popped();
    history.back();
    await back;
    expect(await answer).toBeUndefined();
    expect(marker()).toBeUndefined();
  });
});
