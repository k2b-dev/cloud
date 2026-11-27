import { hydrate } from "solid-js/web";
import { Fixture, type Kind } from "./v2-context.fixture";

declare global {
  interface Window {
    __k2Hydrated?: boolean;
    /** Set by the page before this bundle runs: the fixture the server rendered. */
    __k2Kind?: Kind;
  }
}

// Hydrates the server markup in #root: the development build of Solid throws on any node it cannot find.
const root = document.getElementById("root");
if (!root) throw new Error("context: #root is missing");
hydrate(() => <Fixture kind={window.__k2Kind ?? "form"} />, root);
window.__k2Hydrated = true;
