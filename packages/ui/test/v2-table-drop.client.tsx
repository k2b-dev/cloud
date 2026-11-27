import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { Bar, Pane, Table, Text, Workspace } from "../src/v2";

// Files' list beside its open detail (W1b): a table with a name, two columns that may drop ("Geändert", "Besitzer")
// and "Größe" at the end. At 1024 px with the detail open the list is too narrow for all of them; the columns that may
// drop give way in their order, so "Größe" keeps its words. A hook opens and closes the detail.

declare global {
  interface Window {
    __k2Mounted?: boolean;
    /** Opens or closes the detail beside the list. */
    __k2Detail?: (open: boolean) => void;
  }
}

type File = { id: string; name: string; changed: string; owner: string; size: string };
const files: File[] = [
  { id: "1", name: "Angebot Küchenfront.pdf", changed: "26. Nov. 2026, 09:12", owner: "Anna Brandt", size: "4,2 MB" },
  { id: "2", name: "Aufmaß Einbauschrank Flur.xlsx", changed: "25. Nov. 2026, 17:40", owner: "Jonas Wille", size: "812 KB" },
  { id: "3", name: "Fotos Baustelle", changed: "24. Nov. 2026, 08:03", owner: "Anna Brandt", size: "1,4 GB" },
];

const [detail, setDetail] = createSignal(false);
window.__k2Detail = setDetail;

const root = document.getElementById("root");
if (!root) throw new Error("table-drop: #root is missing");
render(
  () => (
    <Workspace>
      <Pane.Split>
        <Pane label="Dateien">
          <Table
            label="Dateien"
            rows={files}
            rowKey={(file) => file.id}
            open={(file) => ({ href: `#open=${file.id}` })}
            phone={(file) => ({ lines: [file.name, `${file.changed} · ${file.size}`] })}
            columns={[
              { title: "Name", width: { min: 200, default: 280 }, cell: (file) => file.name },
              { title: "Geändert", width: { min: 140, default: 170 }, cell: (file) => file.changed, drop: true },
              { title: "Besitzer", width: { min: 120, default: 150 }, cell: (file) => file.owner, drop: true },
              { title: "Größe", align: "end", width: { min: 90, default: 100 }, cell: (file) => file.size },
            ]}
          />
        </Pane>
        {detail() && (
          <Pane detail label="Angebot Küchenfront.pdf" head={<Bar start={<Text type="lead">Angebot Küchenfront.pdf</Text>} />}>
            <Text>PDF, 4,2 MB</Text>
          </Pane>
        )}
      </Pane.Split>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
