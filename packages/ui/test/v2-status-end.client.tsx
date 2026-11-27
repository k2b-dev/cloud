import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import { Button, Chip, Inline, List, Pane, Row, StatusRow, Workspace } from "../src/v2";

// A status row whose end holds filter chips and an action to create, as the Assistant's "My apps" (W7): on the phone
// its end stays reachable: what has no room beside the shortened statement folds into one "+n", and never just goes.
// `__k2Short()` leaves a short statement and the action alone, which fit beside each other in the row's one line.

declare global {
  interface Window {
    __k2Mounted?: boolean;
    __k2Short?: () => void;
    /** The end as the table demo has it: three chips in an `Inline` (two pressed, with symbols) and an action. */
    __k2Chips?: () => void;
  }
}

const [short, setShort] = createSignal(false);
window.__k2Short = () => setShort(true);
const [chips, setChips] = createSignal(false);
window.__k2Chips = () => setChips(true);

const root = document.getElementById("root");
if (!root) throw new Error("status-end: #root is missing");
render(
  () => (
    <Workspace>
      <Pane
        label="Meine Apps"
        status={
          <StatusRow
            lead={short() ? "12 Apps" : "12 Apps und Automationen"}
            filters={
              <>
                <Show when={chips()}>
                  <Inline>
                    <Chip icon="layers-subtract" pressed onClick={() => undefined}>
                      Nach Status
                    </Chip>
                    <Chip pressed onClick={() => undefined}>
                      Verantwortlich: alle
                    </Chip>
                    <Chip icon="filter" onClick={() => undefined}>
                      Filter
                    </Chip>
                  </Inline>
                </Show>
                <Show when={!short() && !chips()}>
                  <Button pressed>Alle</Button>
                  <Button pressed={false}>Apps</Button>
                  <Button pressed={false}>Automationen</Button>
                </Show>
                <Button icon="plus">Neue App</Button>
              </>
            }
          />
        }
      >
        <List label="Meine Apps">
          <Row lines={["Rechnungen prüfen", "Automation · täglich"]} icon="robot" />
          <Row lines={["Lagerbestand", "App · zuletzt gestern"]} icon="apps" />
        </List>
      </Pane>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
