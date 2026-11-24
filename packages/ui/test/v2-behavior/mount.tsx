import { checkPattern, type Pattern } from "@ui-sdk/core/testing";
import type { Component } from "solid-js";
import { render } from "solid-js/web";

declare global {
  interface Window {
    __checkPattern: (root: Element, name: Pattern) => Promise<void>;
    __mounted: boolean;
    /** Layout shift summed by the reload contract's observer. */
    __shifts?: number;
    /** Mounts and cleanups of the content of the controls demo's second tab panel. */
    __panelMounts?: number;
    __panelCleanups?: number;
  }
}

/**
 * Mounts a demo over the server markup in #root, as an @k2b/ssr island does on Solid 1: it renders again instead of
 * hydrating. The reload contract compares both renders.
 */
export const mount = (Demo: Component) => {
  window.__checkPattern = (root, name) => checkPattern(root, name);
  const root = document.getElementById("root");
  if (!root) throw new Error("mount: #root is missing");
  root.textContent = "";
  render(() => <Demo />, root);
  window.__mounted = true;
};
