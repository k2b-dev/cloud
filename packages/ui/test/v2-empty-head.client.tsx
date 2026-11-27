import { hydrate, render } from "solid-js/web";
import { EmptyHead, type EmptyHeadCase } from "./v2-empty-head.fixture";

// The fixture of empty-head.browser.test.ts (test/v2-empty-head.fixture.tsx): `window.__k2Case` picks the case, and
// with `window.__k2Hydrate` the page hydrates what the server sent instead of rendering anew.

declare global {
  interface Window {
    __k2Mounted?: boolean;
    __k2Case?: EmptyHeadCase;
    __k2Hydrate?: boolean;
    /** What the server sent, cloned before hydration, for the test to compare with the live page. */
    __k2Sent?: Node;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("empty head: #root is missing");
const which = window.__k2Case ?? "hero";
if (window.__k2Hydrate) hydrate(() => <EmptyHead which={which} />, root);
else render(() => <EmptyHead which={which} />, root);
window.__k2Mounted = true;
