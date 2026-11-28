import { render } from "solid-js/web";
import { Bar, Button, Menu, Pane, RecordHead, Text, Workspace } from "../src/v2";

// A record's head on the phone, as Weather shows a place: an avatar, a very long name, its kinds and the head's
// actions (three kept symbols and "…", as a record head with #4373's kept actions shows them on the phone).
// `window.__k2Kinds = false` leaves the kinds out, `window.__k2Name` gives another name, and `window.__k2Mark = true`
// leads with a place's square mark (its symbol on its colour) instead of the round avatar.

declare global {
  interface Window {
    __k2Mounted?: boolean;
    __k2Kinds?: boolean;
    __k2Name?: string;
    __k2Mark?: boolean;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("record head: #root is missing");
const name = window.__k2Name ?? "Sankt Johann im Pongau an der Salzach im Salzburger Land";
const kinds = window.__k2Kinds === false ? undefined : ["Ort", "Favorit"];
render(
  () => (
    <Workspace
      head={
        <Bar
          start={
            window.__k2Mark ? (
              <RecordHead mark={{ icon: "building-carousel", color: "#ca8a04" }} name={name} kinds={kinds} />
            ) : (
              <RecordHead avatar={{ name: "Sankt Johann im Pongau", color: "#0284c7" }} name={name} kinds={kinds} />
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
