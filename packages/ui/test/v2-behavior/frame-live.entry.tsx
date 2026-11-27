import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import { Nav, Pane, Text, Workspace } from "../../src/v2";
import type {} from "./mount";

declare global {
  interface Window {
    /** Shows or hides the second Nav inside the sidebar (`Show`), while the sidebar stays. */
    __more: (visible: boolean) => void;
    /** Shows or hides the whole sidebar: its column and its drawer's button come and go. */
    __sidebar: (visible: boolean) => void;
    /** Makes the sidebar collapsible, or not: the collapse button comes and goes. */
    __collapsible: (collapsible: boolean) => void;
  }
}

// A Workspace an island renders (here mounted at once): it attaches itself, and its sidebar stays reactive while the
// drawer holds it.
const [more, setMore] = createSignal(true);
const [sidebar, setSidebar] = createSignal(true);
const [collapsible, setCollapsible] = createSignal(false);
window.__collapsible = setCollapsible;
window.__more = setMore;
window.__sidebar = setSidebar;
const root = document.getElementById("root");
if (!root) throw new Error("frame-live: #root is missing");
root.textContent = "";
render(
  () => (
    <div class="k2-ui" style={{ position: "fixed", inset: "0", display: "flex" }}>
      <Workspace
        collapsible={collapsible()}
        sidebar={
          <Show when={sidebar()}>
            <Nav
              title="Auftrag"
              icon="briefcase"
              groups={[{ items: [{ label: "Eingang", icon: "inbox", href: "#eingang", current: true }] }]}
            />
            <Show when={more()}>
              <Nav title="Mehr" icon="dots" groups={[{ items: [{ label: "Archiv", icon: "archive", href: "#archiv" }] }]} />
            </Show>
          </Show>
        }
      >
        <Pane.Split>
          <Pane label="Liste" width={{ min: 300, default: 360 }}>
            <Text type="body">Zeilen</Text>
          </Pane>
          <Pane label="Leser">
            <Text type="body">Inhalt</Text>
          </Pane>
        </Pane.Split>
      </Workspace>
    </div>
  ),
  root,
);
window.__mounted = true;
