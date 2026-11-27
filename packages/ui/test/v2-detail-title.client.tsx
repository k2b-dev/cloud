import { render } from "solid-js/web";
import { Bar, Button, List, Pane, Row, StatusRow, Text, Workspace } from "../src/v2";

// An open task beside its list, with the title it has at its worst (Spaces, 96 signs), or another one set before the
// screen starts (`window.__k2Title`): the detail's head shows a long title on two lines at most, the full words as its
// tooltip.

declare global {
  interface Window {
    __k2Mounted?: boolean;
    __k2Title?: string;
  }
}

const longTitle = "Lieferantenrechnungen aus dem Oktober prüfen, mit dem Lager abgleichen und an die Buchhaltung geben";
const title = window.__k2Title ?? longTitle;

const root = document.getElementById("root");
if (!root) throw new Error("detail-title: #root is missing");
render(
  () => (
    <Workspace detail head={<Bar start={<Text type="lead">Aufgaben</Text>} />}>
      <Pane.Split>
        <Pane label="Offene Aufgaben" status={<StatusRow lead="12 offen" />}>
          <List label="Offene Aufgaben">
            <Row icon="circle" lines={[title, "Fällig Freitag"]} href="#a" current />
            <Row icon="circle" lines={["Hof fegen", "Fällig Montag"]} href="#b" />
          </List>
        </Pane>
        <Pane
          detail
          back={{ label: "Aufgaben", href: "#" }}
          label={title}
          head={
            <Bar
              start={
                <Text type="lead" title={title}>
                  {title}
                </Text>
              }
              end={
                <>
                  <Button icon="pencil">Bearbeiten</Button>
                  <Button variant="ghost" icon="x" label="Schließen" href="#" />
                </>
              }
            />
          }
        >
          <Row lines={["Beschreibung folgt"]} />
        </Pane>
      </Pane.Split>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
