import { Avatar, Bar, Icon, Input, List, Menu, Nav, Pane, Row, Tabs, Text, Workspace } from "../src/v2";

/** A Space of a long name, as Spaces names its head (W3). */
export const longName = "Arbeitsgruppe Nachhaltige Beschaffung und Lieferketten im Landkreis Ortenau";

/**
 * The head of a Space (W3): its mark and name, its views as tabs, and a search, its people, the menu of the Space and
 * the one main action.
 */
export function SpaceHead(props: { name: string }) {
  return (
    <Workspace
      sidebar={
        <Nav
          title="Spaces"
          icon="layout-kanban"
          groups={[{ items: [{ label: props.name, icon: "layout-kanban", current: true, href: "#space" }] }]}
        />
      }
      head={
        <Bar
          start={
            <>
              <Icon name="layout-kanban" tone="app" />
              <Text weight="strong">{props.name}</Text>
              <Tabs
                label="Ansichten"
                items={[
                  { label: "Liste", icon: "list", current: true, href: "#liste" },
                  { label: "Tabelle", icon: "table", href: "#tabelle" },
                  { label: "Board", icon: "layout-kanban", href: "#board" },
                  { label: "Kalender", icon: "calendar", href: "#kalender" },
                ]}
              />
            </>
          }
          end={
            <>
              <Input type="search" icon="search" label="Aufgaben durchsuchen" />
              <Avatar name="Ada Lovelace" />
              <Menu
                label="Space-Menü"
                items={[
                  { label: "Mitglieder", icon: "users" },
                  { label: "Einstellungen", icon: "settings" },
                ]}
              />
              <Menu variant="primary" icon="plus" items={[{ label: "Aufgabe" }, { label: "Termin" }]}>
                Neue Aufgabe
              </Menu>
            </>
          }
        />
      }
      primary={{ label: "Neue Aufgabe", icon: "plus", href: "#neu" }}
    >
      <Pane label="Aufgaben">
        <List label="Aufgaben">
          <Row icon="circle" lines={["Lieferanten anschreiben"]} />
          <Row icon="circle" lines={["Kriterien abstimmen"]} />
        </List>
      </Pane>
    </Workspace>
  );
}
