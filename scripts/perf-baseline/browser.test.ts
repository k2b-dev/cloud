import { expect, test } from "bun:test";
import { createDomTestHarness } from "../../packages/ui/test/dom";
import { installProbe, isNetworkChange, transferType } from "./browser";

test("transfer types group script/stylesheet/document separately from fonts and XHR", () => {
  expect(["Script", "script", "Stylesheet", "Document", "Font", "Fetch", "Image"].map(transferType)).toEqual([
    "js",
    "js",
    "css",
    "document",
    "other",
    "other",
    "other",
  ]);
});

test("only Chromium's network-change abort counts as a load that measured nothing", () => {
  expect(isNetworkChange(new Error("goto: net::ERR_NETWORK_CHANGED at https://localhost:1/faq"))).toBe(true);
  expect(isNetworkChange(new Error("goto: net::ERR_CONNECTION_REFUSED at https://localhost:1/faq"))).toBe(false);
  expect(isNetworkChange(new Error("TTI timed out after 45000 ms"))).toBe(false);
});

test("the mount probe counts initial empty clients as well as SSR islands, after synchronous render", async () => {
  const dom = createDomTestHarness();
  const innerHtml = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
  const observer = Object.getOwnPropertyDescriptor(globalThis, "PerformanceObserver");
  Object.defineProperty(globalThis, "PerformanceObserver", {
    configurable: true,
    value: class {
      static supportedEntryTypes: string[] = [];
    },
  });
  try {
    document.body.innerHTML = '<solid-island data-id="shared">SSR content</solid-island><solid-client data-id="shared"></solid-client>';
    installProbe(false);
    const elements = document.querySelectorAll("solid-island,solid-client");
    expect(window.__cloudPerf.mounted.size).toBe(0);
    for (const element of elements) {
      element.innerHTML = "";
      element.append(document.createElement("button"));
    }
    expect(window.__cloudPerf.mounted.size).toBe(0);
    await Promise.resolve();
    expect(window.__cloudPerf.initial?.length).toBe(2);
    expect(window.__cloudPerf.mounted.size).toBe(2);
    const first = elements[0];
    if (!first) throw new Error("Missing test island");
    first.dispatchEvent(new CustomEvent("ssr:island-error", { bubbles: true }));
    expect(window.__cloudPerf.errors).toEqual(["ssr:island-error during initial mount"]);
    expect(window.__cloudPerf.cls).toBeNull();
  } finally {
    if (innerHtml) Object.defineProperty(Element.prototype, "innerHTML", innerHtml);
    if (observer) Object.defineProperty(globalThis, "PerformanceObserver", observer);
    else Reflect.deleteProperty(globalThis, "PerformanceObserver");
    dom.cleanup();
  }
});
