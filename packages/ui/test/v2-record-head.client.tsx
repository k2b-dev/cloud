import { render } from "solid-js/web";
import { Bar, Button, Pane, RecordHead, Text, Workspace } from "../src/v2";

// A record whose name is long and which has three identifiers (W4, Grids): where the head has no room, the identifiers
// give way whole, never pressed to nothing; the name is cut after them, and the head's deeds keep their place.

declare global {
  interface Window {
    __k2Mounted?: boolean;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("record head: #root is missing");
render(
  () => (
    <Workspace
      head={
        <Bar
          start={
            <RecordHead
              name="Vorlage für die jährliche Inventur aller Lager der Werkstatt mit Zählliste, Abweichungen und Freigabe"
              avatar={{ name: "Inventur Werkstatt", color: "#1d4ed8" }}
              kinds={["Vorlage"]}
              ids={[
                { label: "Tabelle", value: "INV-2026-0042", copy: true },
                { label: "Basis", value: "Lager Nord" },
                { icon: "user", value: "Ada Renz" },
              ]}
            />
          }
          end={
            <>
              <Button variant="ghost" icon="share" label="Teilen" />
              <Button variant="primary" icon="plus" menu>
                Neu
              </Button>
            </>
          }
        />
      }
    >
      <Pane label="Inhalt">
        <Text>Zählliste</Text>
      </Pane>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
