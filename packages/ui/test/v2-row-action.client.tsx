import { render } from "solid-js/web";
import { List, Pane, Row, Workspace } from "../src/v2";

// Two rows with the same deed: a screen reader that lists the buttons heard "Ansehen" twice. Each deed is named by its
// words and then by its row's title, so the two are told apart; the second row's title is JSX, not a string.

declare global {
  interface Window {
    __k2Mounted?: boolean;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("row action: #root is missing");
render(
  () => (
    <Workspace>
      <Pane label="Angebote">
        <List label="Angebote">
          <Row lines={["Angebot Küche Lindqvist", "Entwurf"]} action={{ label: "Ansehen", onClick: () => undefined }} />
          <Row
            lines={[
              <>
                Angebot <b>Esstisch</b> Brandner
              </>,
              "Gesendet",
            ]}
            action={{ label: "Ansehen", icon: "eye", onClick: () => undefined }}
          />
        </List>
      </Pane>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
