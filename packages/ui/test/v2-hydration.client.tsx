import { hydrate } from "solid-js/web";
import { Fixture } from "./v2-hydration.fixture";

declare global {
  interface Window {
    __k2Hydrated?: boolean;
    /** What the server sent, cloned before hydration, for the test to compare with the live page. */
    __k2Sent?: Node;
  }
}

// Hydrates the server markup in #root: the development build of Solid throws on any node it cannot find.
const root = document.getElementById("root");
if (!root) throw new Error("hydration: #root is missing");
globalThis.__k2Made = { cells: 0, probe: 0 };
hydrate(() => <Fixture />, root);
window.__k2Hydrated = true;
