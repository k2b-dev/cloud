import { createSignal, For } from "solid-js";
import { render } from "solid-js/web";
import { List, Pane, Row, Workspace } from "../src/v2";

// A list of 40 entries in a column that scrolls, with a hook that puts new entries on top, as new mail arrives.

declare global {
  interface Window {
    __k2Mounted?: boolean;
    /** Puts `count` new entries on top of the list. */
    __k2Prepend?: (count: number) => void;
  }
}

let next = 0;
const [entries, setEntries] = createSignal(Array.from({ length: 40 }, (_, index) => `Eintrag ${index + 1}`));
window.__k2Prepend = (count) => setEntries((list) => [...Array.from({ length: count }, () => `Neu ${++next}`), ...list]);

const root = document.getElementById("root");
if (!root) throw new Error("list: #root is missing");
render(
  () => (
    <Workspace>
      <Pane label="Liste" scrollKey="liste">
        <List label="Einträge">
          <For each={entries()}>{(entry) => <Row lines={[entry, "Zweite Zeile"]} onOpen={() => undefined} />}</For>
        </List>
      </Pane>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
