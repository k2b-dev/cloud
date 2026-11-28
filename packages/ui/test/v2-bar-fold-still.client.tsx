import { render } from "solid-js/web";
import { LocaleProvider } from "../src/intl/locale";
import { List, Pane, Row, StatusRow, Workspace } from "../src/v2";

// A selection with six deeds and its way out ("Auswahl aufheben", at the bar's end with an auto margin) in a column
// whose width the test sweeps: at every width the bar's fold comes to rest.

declare global {
  interface Window {
    __k2Mounted?: boolean;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("bar fold still: #root is missing");
render(
  () => (
    <LocaleProvider locale="de">
      <Workspace>
        <Pane
          label="Dateien"
          status={
            <StatusRow
              lead=""
              selection={{
                count: "3 ausgewählt",
                actions: [
                  { label: "Teilen", icon: "share" },
                  { label: "Verschieben", icon: "folder-symlink" },
                  { label: "Als ZIP laden", icon: "download" },
                  { label: "Löschen", icon: "trash" },
                  { label: "In Ordner kopieren", icon: "copy" },
                  { label: "PDFs zusammenführen", icon: "stack-2" },
                ],
                clear: { label: "Auswahl aufheben", onClick: () => {} },
              }}
            />
          }
        >
          <List label="Dateien">
            <Row lines={["Ansicht Front Eiche.jpg"]} />
          </List>
        </Pane>
      </Workspace>
    </LocaleProvider>
  ),
  root,
);
window.__k2Mounted = true;
