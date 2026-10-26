import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import { kiosk } from "../_internal/installable.test-fixture";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return { ui: await import("@k2b/ui"), Runtime: (await import("./AppPwaRuntime.island")).default };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();
const tick = async () => {
  await Bun.sleep(20);
};
const mount = (options: { ios?: boolean; standalone?: boolean; locale?: string; failure?: boolean; chromium?: boolean } = {}) => {
  const dom = createDomTestHarness();
  const registrations: unknown[][] = [];
  let fail = options.failure;
  Object.defineProperty(dom.window.navigator, "userAgent", {
    configurable: true,
    value: options.ios ? "Mozilla/5.0 (iPad) Version/18.0 Safari/605.1.15" : options.chromium === false ? "Firefox" : "Chrome/130",
  });
  Object.defineProperty(dom.window.navigator, "serviceWorker", {
    configurable: true,
    value: {
      register: async (...args: unknown[]) => {
        registrations.push(args);
        if (fail) throw new Error("Unavailable");
      },
    },
  });
  const display = dom.window.matchMedia("(display-mode: standalone)");
  Object.defineProperty(display, "matches", { configurable: true, value: options.standalone ?? false });
  dom.window.matchMedia = () => display;
  const previousMatchMedia = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
  Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: () => display });
  const { ui, Runtime } = modules!;
  const dispose = render(
    () =>
      createComponent(ui.LocaleProvider, {
        locale: options.locale ?? "en",
        get children() {
          return createComponent(Runtime, { app: kiosk });
        },
      }),
    dom.root,
  );
  const prompt = (failure = false, outcome: "accepted" | "dismissed" = "dismissed") => {
    let calls = 0;
    const event = new dom.window.Event("beforeinstallprompt", { cancelable: true });
    Object.assign(event, {
      prompt: async () => {
        calls++;
        if (failure) throw new Error("Unavailable");
        return { outcome };
      },
      userChoice: Promise.resolve({ outcome: "dismissed" }),
    });
    dom.window.dispatchEvent(event);
    return { event, calls: () => calls };
  };
  return {
    dom,
    registrations,
    prompt,
    recover: () => {
      fail = false;
    },
    cleanup: () => {
      dispose();
      if (previousMatchMedia) Object.defineProperty(globalThis, "matchMedia", previousMatchMedia);
      else Reflect.deleteProperty(globalThis, "matchMedia");
      dom.cleanup();
    },
  };
};

if (isServer) test.skip("requires browser conditions", () => {});
else {
  test("registers exactly its own scope without session calls, activation messages, or reloads; offers Chromium installation only when available", async () => {
    const harness = mount();
    try {
      await tick();
      expect(harness.registrations).toEqual([[`${kiosk.path}sw.js`, { scope: kiosk.path, updateViaCache: "none" }]]);
      expect(harness.dom.root.querySelector("button")).toBeNull();
      const prompt = harness.prompt();
      expect(prompt.event.defaultPrevented).toBe(true);
      expect(harness.dom.root.textContent).toContain("Install Inventory counter");
      harness.dom.root.querySelector<HTMLButtonElement>("button")!.click();
      await tick();
      expect(prompt.calls()).toBe(1);
      expect(harness.dom.root.querySelector("button")).toBeNull();
    } finally {
      harness.cleanup();
    }
  });

  test("accepted installation keeps pending feedback until appinstalled", async () => {
    const harness = mount();
    try {
      await tick();
      harness.prompt(false, "accepted");
      harness.dom.root.querySelector<HTMLButtonElement>("button")!.click();
      await tick();
      expect(harness.dom.root.querySelector("[role=status]")).not.toBeNull();
      expect(harness.dom.root.textContent).toContain("Install Inventory counter");
      harness.dom.window.dispatchEvent(new harness.dom.window.Event("appinstalled"));
      expect(harness.dom.root.textContent).toBe("");
    } finally {
      harness.cleanup();
    }
  });

  test("localized iOS instructions remain manual, and standalone mode hides the install hint", async () => {
    for (const standalone of [false, true]) {
      const harness = mount({ ios: true, standalone, locale: "de" });
      try {
        await tick();
        expect(harness.dom.root.textContent?.includes("Zum Home-Bildschirm")).toBe(!standalone);
        expect(harness.dom.root.querySelector("button")).toBeNull();
      } finally {
        harness.cleanup();
      }
    }
  });

  test("registration failure has a visible retry and install prompt failure leaves guidance", async () => {
    const harness = mount({ failure: true });
    try {
      await tick();
      expect(harness.dom.root.textContent).toContain("Offline support is unavailable");
      harness.recover();
      harness.dom.root.querySelector<HTMLButtonElement>("button")!.click();
      await tick();
      expect(harness.registrations).toHaveLength(2);
      expect(harness.dom.root.textContent).not.toContain("Offline support is unavailable");
      harness.prompt(true);
      harness.dom.root.querySelector<HTMLButtonElement>("button")!.click();
      await tick();
      expect(harness.dom.root.querySelector("[role=alert]")).not.toBeNull();
    } finally {
      harness.cleanup();
    }
  });

  test("uses a browser-offered prompt and removes it after appinstalled", async () => {
    let harness = mount({ chromium: false });
    try {
      expect(harness.prompt().event.defaultPrevented).toBe(true);
      expect(harness.dom.root.querySelector("button")).not.toBeNull();
    } finally {
      harness.cleanup();
    }
    harness = mount();
    try {
      harness.prompt();
      expect(harness.dom.root.querySelector("button")).not.toBeNull();
      harness.dom.window.dispatchEvent(new harness.dom.window.Event("appinstalled"));
      expect(harness.dom.root.querySelector("button")).toBeNull();
    } finally {
      harness.cleanup();
    }
  });
}
