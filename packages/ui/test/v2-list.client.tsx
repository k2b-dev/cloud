import { createSignal, For, Show } from "solid-js";
import { render } from "solid-js/web";
import { List, Pane, Row, Text, Workspace } from "../src/v2";

// A list of 40 entries in a column that scrolls, with hooks that put new entries on top, as new mail arrives, and take
// entries away. A row opens its entry in a detail beside the list; the detail closes in place with its way back.

declare global {
  interface Window {
    __k2Mounted?: boolean;
    /** Puts `count` new entries on top of the list. */
    __k2Prepend?: (count: number) => void;
    /** Takes the named entries out of the list. */
    __k2Remove?: (names: readonly string[]) => void;
  }
}

let next = 0;
const [entries, setEntries] = createSignal(Array.from({ length: 40 }, (_, index) => `Eintrag ${index + 1}`));
const [open, setOpen] = createSignal<string>();
window.__k2Prepend = (count) => setEntries((list) => [...Array.from({ length: count }, () => `Neu ${++next}`), ...list]);
window.__k2Remove = (names) => setEntries((list) => list.filter((entry) => !names.includes(entry)));

const root = document.getElementById("root");
if (!root) throw new Error("list: #root is missing");
render(
  () => (
    <Workspace>
      <Pane.Split>
        <Pane label="Liste" scrollKey="liste">
          <List label="Einträge">
            <For each={entries()}>{(entry) => <Row lines={[entry, "Zweite Zeile"]} onOpen={() => setOpen(entry)} />}</For>
          </List>
        </Pane>
        <Show when={open()}>
          {(entry) => (
            <Pane detail label="Eintrag" back={{ label: "Liste", onClick: () => setOpen(undefined) }}>
              <Text type="lead">{entry()}</Text>
            </Pane>
          )}
        </Show>
      </Pane.Split>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
