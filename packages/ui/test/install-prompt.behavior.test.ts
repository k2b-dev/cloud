import { afterEach, describe, expect, test } from "bun:test";
import { createComponent, createRoot, createSignal } from "solid-js";
import { render } from "solid-js/web";
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

describe("InstallGuide", () => {
  test("follows the state its host hands over after mount, so the browser's own dialog appears", async () => {
    dom = createDomTestHarness();
    Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: dom.window.matchMedia.bind(dom.window) });
    const { default: InstallGuide } = await import("../src/feedback/InstallGuide");
    // The server's view, as a page renders it before the browser's state exists.
    const rendered: InstallPrompt = {
      platform: "android",
      installed: () => false,
      canPrompt: () => false,
      busy: () => false,
      requested: () => false,
      failed: () => false,
      install: async () => {},
    };
    const [install, setInstall] = createSignal(rendered);
    let stopPrompt = () => {};
    const stopGuide = render(
      () =>
        createComponent(InstallGuide, {
          appName: "Northwind",
          get install() {
            return install();
          },
          url: "https://cloud.example/app/",
        }),
      dom.root,
    );
    dispose = () => {
      stopGuide();
      stopPrompt();
    };
    const installButton = () => [...dom.root.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Install app");
    expect(installButton()).toBeUndefined();
    createRoot((done) => {
      stopPrompt = done;
      setInstall(createInstallPrompt());
    });
    offer("accepted");
    expect(installButton()).toBeDefined();
    expect(dom.root.textContent).toContain("Your browser can install Northwind.");
  });

  test("Samsung Internet links to Chrome instead of its own dialog, and keeps the link's fragment", async () => {
    dom = createDomTestHarness();
    Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: dom.window.matchMedia.bind(dom.window) });
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value:
        "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
    });
    const { default: InstallGuide } = await import("../src/feedback/InstallGuide");
    const install = createRoot((done) => {
      dispose = done;
      return createInstallPrompt();
    });
    const stopGuide = render(
      () => createComponent(InstallGuide, { appName: "Northwind", install, url: "https://cloud.example/app/#pair=abc" }),
      dom.root,
    );
    const stopPrompt = dispose;
    dispose = () => {
      stopGuide();
      stopPrompt?.();
    };
    offer("accepted");
    expect(install.platform).toBe("android-samsung");
    expect(install.canPrompt()).toBe(true);
    expect([...dom.root.querySelectorAll("button")].map((button) => button.textContent?.trim())).not.toContain("Install app");
    const chrome = dom.root.querySelector("a");
    expect(chrome?.textContent?.trim()).toBe("Open in Chrome");
    expect(chrome?.getAttribute("href")).toBe(
      "intent://cloud.example/app/#pair=abc#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=https%3A%2F%2Fcloud.example%2Fapp%2F%23pair%3Dabc;end",
    );
  });
});
