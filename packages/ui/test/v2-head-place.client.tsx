import { hydrate } from "solid-js/web";
import { Fixture, type Kind } from "./v2-head-place.fixture";

declare global {
  interface Window {
    __k2Hydrated?: boolean;
    /** Set by the page before this bundle runs: the fixture the server rendered. */
    __k2HeadPlaceKind?: Kind;
  }
}

// Hydrates the server markup in #root: the development build of Solid throws on any node it cannot find.
const root = document.getElementById("root");
if (!root) throw new Error("head place: #root is missing");
hydrate(() => <Fixture kind={window.__k2HeadPlaceKind ?? "creates"} />, root);
window.__k2Hydrated = true;
