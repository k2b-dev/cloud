import { expect, mock, test } from "bun:test";
import { closePanel, openPanel, type PanelRequest } from "./panel";

test("the event bridge returns synchronous acceptance and filters search without module state", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const browser = new EventTarget();
  Object.defineProperty(browser, "parent", { value: browser });
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
  const requests: PanelRequest[] = [];
  const listener = (event: CustomEvent<PanelRequest>) => {
    requests.push(event.detail);
    if (event.detail.action === "open" && event.detail.provider === "visible") event.detail.accepted = true;
  };
  try {
    expect(openPanel("visible")).toBe(false);
    window.addEventListener("cloud.panel.request", listener);
    expect(openPanel("visible", { search: "?q=hello" })).toBe(true);
    expect(requests.at(-1)).toMatchObject({ provider: "visible", search: "?q=hello", accepted: true });
    expect(openPanel("hidden")).toBe(false);
    expect(openPanel("visible", { search: "q=x" })).toBe(true);
    expect(requests.at(-1)).toMatchObject({ search: "q=x" });
    openPanel("visible", { search: "x".repeat(2049) });
    expect(requests.at(-1)).toMatchObject({ search: undefined });
    const options = { search: "safe" };
    Reflect.set(options, "search", 42);
    openPanel("visible", options);
    expect(requests.at(-1)).toMatchObject({ search: undefined });
    closePanel();
    expect(requests.at(-1)).toEqual({ action: "close" });
  } finally {
    window.removeEventListener("cloud.panel.request", listener);
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

for (const embedded of [false, true]) {
  for (const providerPage of [false, true]) {
    test(`closePanel uses the parent only on an embedded provider page (embedded=${embedded}, provider=${providerPage})`, () => {
      const keys = ["window", "document", "location"] as const;
      const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
      const browser = new EventTarget();
      const postMessage = mock((_message: unknown, _targetOrigin: string) => {});
      Object.defineProperty(browser, "parent", { value: embedded ? { postMessage } : browser });
      const querySelector = mock((_selector: string) => (providerPage ? {} : null));
      const requests: unknown[] = [];
      browser.addEventListener("cloud.panel.request", (event) => {
        if (event instanceof CustomEvent) requests.push(event.detail);
      });
      Object.defineProperties(globalThis, {
        window: { configurable: true, value: browser },
        document: { configurable: true, value: { querySelector } },
        location: { configurable: true, value: { origin: "https://cloud.test" } },
      });
      try {
        // Provider pages have no shell or slot to accept an open request.
        expect(openPanel("fixture")).toBe(false);
        requests.length = 0;
        closePanel();
        if (embedded && providerPage) {
          expect(querySelector).toHaveBeenCalledWith("[data-cloud-panel-page]");
          expect(postMessage.mock.calls).toEqual([[{ type: "cloud.panel.close" }, "https://cloud.test"]]);
          expect(requests).toEqual([]);
        } else {
          expect(postMessage).not.toHaveBeenCalled();
          expect(requests).toEqual([{ action: "close" }]);
        }
      } finally {
        keys.forEach((key, index) => {
          const descriptor = previous[index];
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else Reflect.deleteProperty(globalThis, key);
        });
      }
    });
  }
}
