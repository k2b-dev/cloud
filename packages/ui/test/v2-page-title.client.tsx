import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import { Bar, Button, Pane, RecordHead, Section, Workspace } from "../src/v2";

// Two Workspaces whose head changes while the page lives, each part in two `Show`s that never stand at once: one swaps
// the record its head names, one swaps the Bar of its head. `window.__k2SwapHead(which)` flips one of them.

declare global {
  interface Window {
    __k2Mounted?: boolean;
    __k2SwapHead?: (which: "record" | "bar") => void;
  }
}

const [record, setRecord] = createSignal(true);
const [firstBar, setFirstBar] = createSignal(true);
window.__k2SwapHead = (which) => (which === "record" ? setRecord((now) => !now) : setFirstBar((now) => !now));

const root = document.getElementById("root");
if (!root) throw new Error("page-title: #root is missing");
render(
  () => (
    <>
      <div id="records">
        <Workspace
          title="Agenten"
          head={
            <Bar
              start={
                <>
                  <Show when={record()}>
                    <RecordHead name="Wochenbericht" />
                  </Show>
                  <Show when={!record()}>
                    <RecordHead name="Monatsbericht" />
                  </Show>
                </>
              }
              end={<Button>Pausieren</Button>}
            />
          }
        >
          <Pane label="Agent">
            <Section title="Zustand" />
          </Pane>
        </Workspace>
      </div>
      <div id="bars">
        <Workspace
          title="Berichte"
          head={
            <>
              <Show when={firstBar()}>
                <Bar end={<Button>Neu</Button>} />
              </Show>
              <Show when={!firstBar()}>
                <Bar end={<Button>Teilen</Button>} />
              </Show>
            </>
          }
        >
          <Pane label="Berichte">
            <Section title="Liste" />
          </Pane>
        </Workspace>
      </div>
    </>
  ),
  root,
);
window.__k2Mounted = true;
