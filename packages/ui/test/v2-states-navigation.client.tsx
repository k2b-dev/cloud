import { installPageSwap, swapPage } from "@k2b/ssr/nav";
import { hydrate } from "solid-js/web";
import { Fixture } from "./v2-states-navigation.fixture";

declare global {
  interface Window {
    __k2Hydrated?: boolean;
    /** What the server sent, cloned before hydration, for the test to compare with the live page. */
    __k2Sent?: Node;
    /** The page swap of `@k2b/ssr/nav`, for the test that a link opening in place cancels a pending swap. */
    __k2Swap?: { install: typeof installPageSwap; swap: typeof swapPage };
  }
}

// Hydrates the server markup in #root: the development build of Solid throws on any node it cannot find.
const root = document.getElementById("root");
if (!root) throw new Error("states and navigation: #root is missing");
hydrate(() => <Fixture />, root);
window.__k2Swap = { install: installPageSwap, swap: swapPage };
window.__k2Hydrated = true;
