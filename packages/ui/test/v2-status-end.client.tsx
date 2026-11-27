import { render } from "solid-js/web";
import { Button, List, Pane, Row, StatusRow, Workspace } from "../src/v2";

// A status row whose end holds filter chips and an action to create, as the Assistant's "My apps" (W7): on the phone
// its end stays reachable, whole, in a second line where the first has no room, and never just goes.

declare global {
  interface Window {
    __k2Mounted?: boolean;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("status-end: #root is missing");
render(
  () => (
    <Workspace>
      <Pane
        label="Meine Apps"
        status={
          <StatusRow
            lead="12 Apps und Automationen"
            filters={
              <>
                <Button pressed>Alle</Button>
                <Button pressed={false}>Apps</Button>
                <Button pressed={false}>Automationen</Button>
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
