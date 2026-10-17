import { expect, test } from "bun:test";
import { closePanel, openPanel, type PanelRequest } from "./panel";

test("the event bridge returns synchronous acceptance and filters search without module state", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
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
