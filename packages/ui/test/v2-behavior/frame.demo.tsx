import { Bar, Nav, Pane, Table, Text, Workspace } from "../../src/v2";

/**
 * A Workspace as a server renders it, with no island: a Nav with a fold as the sidebar, a head and a list beside its
 * reader with a table. The list keeps 300 px and the reader 400, so the sidebar is a column from 950 px of workspace on
 * and a drawer below.
 */
export function Demo() {
  return (
    <div class="k2-ui" style={{ position: "fixed", inset: "0", display: "flex" }}>
      <Workspace
        collapsible
        sidebar={
          <Nav
            title="Auftrag"
            icon="briefcase"
            groups={[
              {
                items: [
                  { label: "Eingang", icon: "inbox", href: "#eingang", current: true },
                  { label: "Archiv", items: [{ label: "2025", icon: "folder", href: "#2025" }] },
                ],
              },
            ]}
          />
        }
        head={<Bar start={<Text type="lead">Aufträge</Text>} />}
      >
        <Pane.Split>
          <Pane label="Liste" width={{ min: 300, default: 360 }}>
            <Text type="body">Zeilen</Text>
          </Pane>
          <Pane label="Leser">
            <Text type="body">Inhalt</Text>
            {/* where a person types: Mod+Alt+S there is a letter, not the shortcut */}
            <input aria-label="Notiz" />
            {/* a column with a width has a grip in the head of the column after it */}
            <Table
              label="Positionen"
              rows={[{ name: "Eichenplatte", count: "2" }]}
              columns={[
                { title: "Artikel", width: { min: 120, default: 200 }, cell: (row) => row.name },
                { title: "Menge", cell: (row) => row.count },
              ]}
            />
          </Pane>
        </Pane.Split>
      </Workspace>
    </div>
  );
}
