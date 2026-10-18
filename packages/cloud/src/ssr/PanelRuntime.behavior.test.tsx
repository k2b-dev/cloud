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
  const mount = (embedded = true, crossOrigin = false, props: { scope?: string } = { scope: "/app/fixture/panel/" }) => {
    const dom = createDomTestHarness();
    // Happy DOM runs an anchor's native navigation before the click reaches window.
    const open = jest.spyOn(dom.window, "open").mockReturnValue(null);
    const postMessage = mock((_message: unknown, _targetOrigin: string) => {});
    const assign = mock((_url: string) => {});
    const parentDocument = document.implementation.createHTMLDocument();
    parentDocument.documentElement.className = "dark host";
    const parent = Object.assign(new dom.window.EventTarget(), { postMessage, location: { assign } });
    Object.defineProperty(parent, "document", {
      get: () => {
        if (crossOrigin) throw new DOMException("Blocked cross-origin parent", "SecurityError");
        return parentDocument;
      },
    });
    Object.defineProperty(dom.window, "parent", { configurable: true, value: embedded ? parent : dom.window });
    document.documentElement.className = "light provider";
    document.cookie = `cloud.timezone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}; Path=/`;
    const dispose = render(() => createComponent(PanelRuntime, { provider: "fixture", ...props }), dom.root);
    cleanup = () => {
      dispose();
      open.mockRestore();
      dom.cleanup();
    };
    const click = (href: string, init: MouseEventInit = {}, attributes: Record<string, string> = {}, prevented = false) => {
      const anchor = document.createElement("a");
      anchor.href = href;
      for (const [name, value] of Object.entries(attributes)) anchor.setAttribute(name, value);
      const child = document.createElement("span");
      anchor.append(child);
      dom.root.append(anchor);
      if (prevented) anchor.addEventListener("click", (event) => event.preventDefault());
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
      child.dispatchEvent(event);
      return event;
    };
    return { dom, postMessage, dispose, parent, parentDocument, assign, click };
  };
  test("same-origin links outside the panel scope navigate the parent and clean up on dispose", () => {
    const h = mount();
    const base = document.createElement("base");
    base.href = "/app/";
    document.head.append(base);
    expect(h.click("other?item=1#detail", {}, { target: "_self" }).defaultPrevented).toBe(true);
    expect(h.assign).toHaveBeenLastCalledWith("http://localhost/app/other?item=1#detail");
    expect(h.click("/app/fixture/panels").defaultPrevented).toBe(true);
    expect(h.assign).toHaveBeenLastCalledWith("http://localhost/app/fixture/panels");
    h.dispose();
    expect(h.click("/app/other").defaultPrevented).toBe(false);
    expect(h.assign).toHaveBeenCalledTimes(2);
  });
  for (const href of ["/app/fixture/panel", "/app/fixture/panel/", "/app/fixture/panel/item?q=1#detail"]) {
    test(`links within the panel scope stay native: ${href}`, () => {
      const h = mount();
      expect(h.click(href).defaultPrevented).toBe(false);
      expect(h.assign).not.toHaveBeenCalled();
    });
  }
  test("hash links within the panel scope stay native", () => {
    const h = mount();
    history.replaceState(null, "", "/app/fixture/panel");
    expect(h.click("#detail").defaultPrevented).toBe(false);
    expect(h.assign).not.toHaveBeenCalled();
  });
  test("provider handlers that prevent a click keep control", () => {
    const h = mount();
    expect(h.click("/app/other", {}, {}, true).defaultPrevented).toBe(true);
    expect(h.assign).not.toHaveBeenCalled();
  });
  for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { button: 1 }]) {
    test(`modified and non-primary clicks stay native: ${JSON.stringify(init)}`, () => {
      const h = mount();
      expect(h.click("/app/other", init).defaultPrevented).toBe(false);
      expect(h.assign).not.toHaveBeenCalled();
    });
  }
  for (const name of ["target", "download"]) {
    test(`links with explicit browser behavior stay native: ${name}`, () => {
      const h = mount();
      expect(h.click("/app/other", {}, { [name]: name === "target" ? "_blank" : "" }).defaultPrevented).toBe(false);
      expect(h.assign).not.toHaveBeenCalled();
    });
  }
  test("cross-origin links stay native", () => {
    const h = mount();
    expect(h.click("https://elsewhere.test/app/other").defaultPrevented).toBe(false);
    expect(h.assign).not.toHaveBeenCalled();
  });
  test("without a scope every same-origin link navigates the parent", () => {
    const h = mount(true, false, {});
    expect(h.click("/app/fixture/panel").defaultPrevented).toBe(true);
    expect(h.assign).toHaveBeenCalledWith("http://localhost/app/fixture/panel");
  });
  test("standalone providers keep navigation native", () => {
    const h = mount(false);
    expect(h.click("/app/other").defaultPrevented).toBe(false);
    expect(h.assign).not.toHaveBeenCalled();
  });
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
  test("Escape while a modal dialog is open belongs to the dialog, not to the panel", () => {
    jest.useFakeTimers();
    const h = mount();
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    h.dom.root.append(dialog);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    jest.runAllTimers();
    expect(h.postMessage.mock.calls.some(([message]) => JSON.stringify(message).includes("cloud.panel.close"))).toBe(false);
    dialog.remove();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    jest.runAllTimers();
    expect(h.postMessage.mock.calls.at(-1)).toEqual([{ type: "cloud.panel.close" }, "http://localhost"]);
  });
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
