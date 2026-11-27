import { render } from "solid-js/web";
import { Bar, Button, Facts, Pane, RecordHead, Text, Workspace } from "../src/v2";

// A record whose name is long and which has three identifiers (W4, Grids): where the head has no room, the identifiers
// give way whole, never pressed to nothing; the name is cut after them, and the head's deeds keep their place.

declare global {
  interface Window {
    __k2Mounted?: boolean;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("record head: #root is missing");
// `<body data-case="weather">`: a station of Weather (W8) whose name runs to 120 signs with one word of 55 that has no
// break; its facts stand under the head
if (document.body.dataset.case === "weather")
  render(
    () => (
      <Workspace
        head={
          <Bar
            start={
              <RecordHead
                name="Wetterstation Oberjoch Bergstation Süd mit Windmesser, Regen und Hochgebirgsniederschlagsbeobachtungsmessnetzwerkstation"
                kinds={["Station"]}
              />
            }
            end={<Button variant="ghost" icon="share" label="Teilen" />}
          />
        }
      >
        <Pane label="Inhalt">
          <Facts
            items={[
              { label: "Höhe", value: "1.520 m" },
              { label: "Zuletzt", value: "heute, 03:10" },
            ]}
          />
        </Pane>
      </Workspace>
    ),
    root,
  );
else
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
