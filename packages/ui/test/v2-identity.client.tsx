import { render } from "solid-js/web";
import { IdentityScreen } from "./v2-identity.fixture";

// The identity screen in the browser: its thumbnails load or fail for real, and the hooks count the deeds of the card
// that makes a new thing.

declare global {
  interface Window {
    __k2Mounted?: boolean;
    /** What was pressed on the card that makes a new thing: its name, then each quick choice. */
    __k2Pressed?: string[];
  }
}

const pressed: string[] = [];
window.__k2Pressed = pressed;
const root = document.getElementById("root");
if (!root) throw new Error("identity: #root is missing");
render(() => <IdentityScreen onCreate={() => pressed.push("Neue Base")} onChoice={(name) => pressed.push(name)} />, root);
window.__k2Mounted = true;
