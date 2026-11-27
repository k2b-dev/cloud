import { For } from "solid-js";
import { render } from "solid-js/web";
import { Bar, Canvas, Pane, Text, Workspace } from "../src/v2";

// A chat as the Assistant and Chat draw it (W7, W9): a `Canvas height="fill"` that is the whole pane, holding one
// column that asks for no height of its own: a history with its own scroller (as VirtualFeed has), far taller than the
// phone, and a composer under it. The test picks the layout before the script runs: the pane alone, or in a split.

declare global {
  interface Window {
    __k2Mounted?: boolean;
    __k2Layout?: "pane" | "split";
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("canvas-fill: #root is missing");
const chat = () => (
  <Pane label="Unterhaltung">
    <Canvas label="Unterhaltung mit Gustav" height="fill">
      <div class="chat">
        <div class="chat-history">
          <For each={Array.from({ length: 120 }, (_, index) => index + 1)}>
            {(index) => <p class="chat-message">Nachricht {index}: Die Lieferung für die Werkstatt Nord ist unterwegs.</p>}
          </For>
        </div>
        <textarea class="chat-composer" aria-label="Nachricht" rows={2} />
      </div>
    </Canvas>
  </Pane>
);
render(
  () => (
    <Workspace head={<Bar start={<Text type="lead">Gustav</Text>} />}>
      {window.__k2Layout === "split" ? <Pane.Split>{chat()}</Pane.Split> : chat()}
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
