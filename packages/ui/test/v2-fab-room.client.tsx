import { For } from "solid-js";
import { render } from "solid-js/web";
import { Bar, Pane, Row, Text, Workspace } from "../src/v2";

// A list longer than the phone with the page's main action floating over it, as Weather's places or a mail list: one
// pane alone, or (`__k2Split`) two panes of a split that stand one under the other on the phone. The test scrolls to the
// end and reads whether the floating action leaves the last row readable.

declare global {
  interface Window {
    __k2Mounted?: boolean;
    /** Two panes of a split instead of one pane. */
    __k2Split?: boolean;
  }
}

const rows = Array.from({ length: 30 }, (_, index) => `Eintrag ${index + 1}`);
const list = (label: string) => (
  <Pane label={label}>
    <For each={rows}>{(row) => <Row lines={[`${label} · ${row}`]} meta="80 %" />}</For>
  </Pane>
);
const split = window.__k2Split === true;

const root = document.getElementById("root");
if (!root) throw new Error("fab room: #root is missing");
render(
  () => (
    <Workspace head={<Bar start={<Text type="lead">Liste</Text>} />} primary={{ label: "Ort hinzufügen", icon: "plus" }}>
      {split ? (
        <Pane.Split>
          {list("Erste")}
          {list("Zweite")}
        </Pane.Split>
      ) : (
        list("Liste")
      )}
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
