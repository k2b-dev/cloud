import { hydrate } from "solid-js/web";
import { Fixture } from "./v2-bar-fold.fixture";

declare global {
  interface Window {
    __k2Hydrated?: boolean;
  }
}

// Hydrates the server markup in #root: the development build of Solid throws on any node it cannot find.
const root = document.getElementById("root");
if (!root) throw new Error("bar-fold: #root is missing");
hydrate(() => <Fixture />, root);
window.__k2Hydrated = true;
