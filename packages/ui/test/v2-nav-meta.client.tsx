import { render } from "solid-js/web";
import { Nav } from "../src/v2";

// The Assistant's chats in the sidebar (W7): a chat "an Orten" says its place on a quiet second line; a long name and a
// long place each stay on one line and end in "…"; an entry without a place keeps its one line.

declare global {
  interface Window {
    __k2Mounted?: boolean;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("nav meta: #root is missing");
render(
  () => (
    // as wide as a sidebar (Workspace keeps it near 260 px; the phone's drawer is no wider than the screen)
    <div style={{ display: "flex", width: "min(100%, 260px)", height: "100%" }}>
      <Nav
        title="Assistent"
        icon="moustache"
        groups={[
          {
            label: "Chats",
            items: [
              {
                label: "Abnahme der Musterfronten nach dem zweiten Ölen mit der Kundin",
                icon: "message",
                href: "#c1",
                meta: "Werkstatt Lindenstraße 12, Halle 3, hinten links beim Rolltor",
                current: true,
              },
              { label: "Angebot Küche", icon: "message", href: "#c2", meta: "Büro", dot: "running" },
              { label: "Ohne Ort", icon: "message", href: "#c3" },
              // an entry with deeds of its own: under the pointer its "…" takes the end of the first line only
              {
                label: "Lager",
                icon: "message",
                href: "#c4",
                meta: "Halle 2, Regal 14, hinten beim Tor neben der Rampe für die Anlieferung",
                menu: [{ label: "Ausblenden", onClick: () => undefined }],
              },
            ],
          },
        ]}
      />
    </div>
  ),
  root,
);
window.__k2Mounted = true;
