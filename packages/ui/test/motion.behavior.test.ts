import { expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { prefersReducedMotion } from "../src/motion";
import { createDomTestHarness } from "./dom";

test.skipIf(isServer)("reads the OS and host motion preferences on each call", () => {
  const dom = createDomTestHarness();
  let reduced = false;
  Object.defineProperty(dom.window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({ media: query, matches: reduced && query === "(prefers-reduced-motion: reduce)" }),
  });
  try {
    expect(prefersReducedMotion()).toBe(false);
    reduced = true;
    expect(prefersReducedMotion()).toBe(true);
    reduced = false;
    dom.document.documentElement.setAttribute("data-k2b-motion", "reduced");
    expect(prefersReducedMotion()).toBe(true);
    dom.document.documentElement.removeAttribute("data-k2b-motion");
    expect(prefersReducedMotion()).toBe(false);
    Object.defineProperty(dom.window, "matchMedia", { configurable: true, value: undefined });
    expect(prefersReducedMotion()).toBe(false);
    dom.document.documentElement.setAttribute("data-k2b-motion", "reduced");
    expect(prefersReducedMotion()).toBe(true);
  } finally {
    dom.cleanup();
  }
});
