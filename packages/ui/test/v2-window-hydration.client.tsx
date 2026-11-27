import { hydrate } from "solid-js/web";
import { Fixture, type Kind } from "./v2-window-hydration.fixture";

declare global {
  interface Window {
    __k2Hydrated?: boolean;
    /** Set by the page before this bundle runs: the fixture the server rendered. */
    __k2WindowKind?: Kind;
  }
}

// Hydrates the server markup in #root: the development build of Solid throws on any node it cannot find.
const root = document.getElementById("root");
if (!root) throw new Error("window hydration: #root is missing");
hydrate(() => <Fixture kind={window.__k2WindowKind ?? "groups"} />, root);
window.__k2Hydrated = true;
