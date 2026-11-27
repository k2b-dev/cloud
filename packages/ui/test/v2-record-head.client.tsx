import { render } from "solid-js/web";
import { Bar, Button, Menu, Pane, RecordHead, Text, Workspace } from "../src/v2";

// A record's head on the phone, as Weather shows a place: an avatar, a very long name, its kinds and the head's
// actions ("…" and one kept action). `window.__k2Kinds = false` leaves the kinds out.

declare global {
  interface Window {
    __k2Mounted?: boolean;
    __k2Kinds?: boolean;
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
              avatar={{ name: "Sankt Johann im Pongau", color: "#0284c7" }}
              name="Sankt Johann im Pongau an der Salzach im Salzburger Land"
              kinds={window.__k2Kinds === false ? undefined : ["Ort", "Favorit"]}
            />
          }
          end={
            <>
              <Button keep icon="star" label="Merken" />
              <Menu items={[{ label: "Umbenennen", icon: "pencil" }]} />
            </>
          }
        />
      }
    >
      <Pane label="Wetter">
        <Text>Heute sonnig.</Text>
      </Pane>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
