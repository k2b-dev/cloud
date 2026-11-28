import { render } from "solid-js/web";
import { Bar, Button, Menu, Pane, RecordHead, Text, Workspace } from "../src/v2";

// A record's head on the phone, as Weather shows a place: an avatar, a very long name, its kinds and the head's
// actions (three kept symbols and "…", as a record head with #4373's kept actions shows them on the phone).
// `window.__k2Kinds = false` leaves the kinds out. `window.__k2Meta = true` shows a thing instead, as a run in
// gateway-ops: its app's mark, its name and a quiet line under it, the kinds given way.

declare global {
  interface Window {
    __k2Mounted?: boolean;
    __k2Kinds?: boolean;
    __k2Meta?: boolean;
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
            window.__k2Meta ? (
              <RecordHead
                mark={{ icon: "notebook", color: "#7c3aed" }}
                name="Suchindex nachziehen"
                meta="Job · Notizbücher · notebooks:reindex"
                kinds={["Job"]}
              />
            ) : (
              <RecordHead
                avatar={{ name: "Sankt Johann im Pongau", color: "#0284c7" }}
                name="Sankt Johann im Pongau an der Salzach im Salzburger Land"
                kinds={window.__k2Kinds === false ? undefined : ["Ort", "Favorit"]}
              />
            )
          }
          end={
            <>
              <Button keep icon="search" label="In der Akte suchen" />
              <Button keep icon="star" label="Merken" />
              <Button keep icon="share" label="Teilen" />
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
