import { Bar, Nav, Pane, Text, Workspace } from "../../src/v2";

/**
 * A Workspace as a server renders it, with no island: a Nav with a fold as the sidebar, a head and a list beside its
 * reader. The list keeps 300 px and the reader 400, so the sidebar is a column from 950 px of workspace on and a
 * drawer below.
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
          </Pane>
        </Pane.Split>
      </Workspace>
    </div>
  );
}
