import { afterEach, expect, jest, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

if (isServer) test.skip("requires browser conditions and solid-dom-preload", () => {});
else {
  const bootstrap = createDomTestHarness();
  const { default: PanelRuntime } = await import("./PanelRuntime.island");
  const { keyboardPlatform } = await import("@k2b/ui");
  bootstrap.cleanup();
  let cleanup = () => {};
  afterEach(() => {
    cleanup();
    jest.useRealTimers();
  });
  const mount = (embedded = true, crossOrigin = false) => {
    const dom = createDomTestHarness();
    const postMessage = mock((_message: unknown, _targetOrigin: string) => {});
    const parentDocument = document.implementation.createHTMLDocument();
    parentDocument.documentElement.className = "dark host";
    const parent = Object.assign(new dom.window.EventTarget(), { postMessage });
    Object.defineProperty(parent, "document", {
      get: () => {
        if (crossOrigin) throw new DOMException("Blocked cross-origin parent", "SecurityError");
        return parentDocument;
      },
    });
    Object.defineProperty(dom.window, "parent", { configurable: true, value: embedded ? parent : dom.window });
    document.documentElement.className = "light provider";
    document.cookie = `cloud.timezone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}; Path=/`;
    const dispose = render(() => createComponent(PanelRuntime, { provider: "fixture" }), dom.root);
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    return { dom, postMessage, dispose, parent, parentDocument };
  };
  for (const teardown of ["dispose", "pagehide"]) {
    test(`mirrors the host theme live and removes its listener on ${teardown}`, () => {
      const h = mount();
      expect(document.documentElement.className).toBe("provider dark");
      const changeTheme = (theme: string) => {
        h.parentDocument.documentElement.className = `${theme} host`;
        h.parent.dispatchEvent(new h.dom.window.Event("cloud:theme-preference"));
      };
      changeTheme("light");
      expect(document.documentElement.className).toBe("provider light");
      changeTheme("dark");
      expect(document.documentElement.className).toBe("provider dark");
      if (teardown === "dispose") h.dispose();
      else window.dispatchEvent(new Event("pagehide"));
      changeTheme("light");
      expect(document.documentElement.className).toBe("provider dark");
    });
  }
  test("a page kept in the back/forward cache keeps following the host theme", () => {
    const h = mount();
    const changeTheme = (theme: string) => {
      h.parentDocument.documentElement.className = `${theme} host`;
      h.parent.dispatchEvent(new h.dom.window.Event("cloud:theme-preference"));
    };
    window.dispatchEvent(Object.assign(new Event("pagehide"), { persisted: true }));
    h.parentDocument.documentElement.className = "light host";
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    expect(document.documentElement.className).toBe("provider light");
    changeTheme("dark");
    expect(document.documentElement.className).toBe("provider dark");
  });
  test("a cross-origin parent cannot throw during mount and keys still post to the provider origin", () => {
    const h = mount(true, true);
    expect(document.documentElement.className).toBe("light provider");
    const apple = keyboardPlatform() === "apple";
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", metaKey: apple, ctrlKey: !apple, cancelable: true }));
    expect(h.postMessage.mock.calls.at(-1)).toEqual([{ type: "cloud.panel.close" }, "http://localhost"]);
  });
  test("posts exact ready and mod+J close messages to the origin and cleans up", () => {
    const h = mount();
    expect(h.postMessage.mock.calls).toEqual([[{ type: "cloud.panel.ready", v: 1, provider: "fixture" }, "http://localhost"]]);
    const apple = keyboardPlatform() === "apple";
    const key = (extra: KeyboardEventInit = {}) =>
      new KeyboardEvent("keydown", { key: "J", metaKey: apple, ctrlKey: !apple, cancelable: true, ...extra });
    window.dispatchEvent(key({ shiftKey: true }));
    window.dispatchEvent(key({ altKey: true }));
    window.dispatchEvent(key({ isComposing: true }));
    expect(h.postMessage).toHaveBeenCalledTimes(1);
    const event = key();
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(h.postMessage.mock.calls[1]).toEqual([{ type: "cloud.panel.close" }, "http://localhost"]);
    h.dispose();
    window.dispatchEvent(key());
    expect(h.postMessage).toHaveBeenCalledTimes(2);
  });
  test("Escape waits until later bubble handlers can prevent it, and cancels deferred work on dispose", () => {
    jest.useFakeTimers();
    const h = mount();
    const prevent = (event: KeyboardEvent) => event.preventDefault();
    window.addEventListener("keydown", prevent);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    window.removeEventListener("keydown", prevent);
    jest.advanceTimersByTime(0);
    expect(h.postMessage).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(h.postMessage).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(0);
    expect(h.postMessage).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    h.dispose();
    jest.advanceTimersByTime(0);
    expect(h.postMessage).toHaveBeenCalledTimes(2);
  });
  test("a standalone provider installs input mode without posting or intercepting keys", () => {
    const h = mount(false);
    expect(document.documentElement.className).toBe("light provider");
    const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    window.dispatchEvent(event);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(document.documentElement.hasAttribute("data-k2b-kbd")).toBe(true);
    expect(h.postMessage).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
}
