import { afterEach, describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { createInstallPrompt, type InstallPrompt } from "../src/feedback/install";
import { createDomTestHarness, type DomTestHarness } from "./dom";

let dom: DomTestHarness;
let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dom.cleanup();
});

const mount = (): InstallPrompt => {
  dom = createDomTestHarness();
  Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: dom.window.matchMedia.bind(dom.window) });
  return createRoot((done) => {
    dispose = done;
    return createInstallPrompt();
  });
};

/** What Chrome dispatches when the page is installable; `prompt()` settles with the person's choice. */
const offer = (outcome: "accepted" | "dismissed" | Error) => {
  const event = new Event("beforeinstallprompt", { cancelable: true });
  let prompts = 0;
  Object.assign(event, {
    prompt: async () => {
      prompts++;
      if (outcome instanceof Error) throw outcome;
      return { outcome };
    },
  });
  window.dispatchEvent(event);
  return { event, prompts: () => prompts };
};

describe("createInstallPrompt", () => {
  test("captures the browser's offer and opens it once from install()", async () => {
    const install = mount();
    expect(install.canPrompt()).toBe(false);
    const offered = offer("accepted");
    expect(offered.event.defaultPrevented).toBe(true);
    expect(install.canPrompt()).toBe(true);
    const pending = install.install();
    expect(install.busy()).toBe(true);
    expect(install.canPrompt()).toBe(false);
    await pending;
    expect(install.busy()).toBe(false);
    expect(install.requested()).toBe(true);
    await install.install();
    expect(offered.prompts()).toBe(1);
  });

  test("a dismissed dialog is not a request, and a failed one is reported until the next try", async () => {
    const install = mount();
    offer("dismissed");
    await install.install();
    expect(install.requested()).toBe(false);
    offer(new Error("blocked"));
    await install.install();
    expect(install.failed()).toBe(true);
    offer("accepted");
    await install.install();
    expect(install.failed()).toBe(false);
    expect(install.requested()).toBe(true);
  });

  test("an installed app offers nothing more", async () => {
    const install = mount();
    offer("accepted");
    window.dispatchEvent(new Event("appinstalled"));
    expect(install.installed()).toBe(true);
    expect(install.canPrompt()).toBe(false);
    offer("accepted");
    expect(install.canPrompt()).toBe(false);
    await install.install();
    expect(install.busy()).toBe(false);
  });

  test("stops listening when its owner is disposed", () => {
    const install = mount();
    dispose?.();
    dispose = undefined;
    offer("accepted");
    expect(install.canPrompt()).toBe(false);
  });
});
