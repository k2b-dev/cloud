import { Avatar, Bar, Button, Icon, Input, List, Menu, Nav, Pane, Row, Tabs, Text, Workspace } from "../src/v2";

/** A Space of a long name, as Spaces names its head (W3). */
export const longName = "Arbeitsgruppe Nachhaltige Beschaffung und Lieferketten im Landkreis Ortenau";

declare global {
  interface Window {
    /** How often the head's "Teilen" ran, from the head or from its "…". */
    __shared?: number;
  }
}

/**
 * The head of a Space (W3): its mark and name, its views as tabs, and a search, its people, a deed, a link, a menu of
 * views, the menu of the Space ("…") and the one main action. `deeds` adds a deed, a link and a menu with words
 * beside the people; `more: false` leaves the "…" out.
 */
export function SpaceHead(props: { name: string; deeds?: boolean; more?: boolean }) {
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
              <Input type="search" icon="search" label="Aufgaben durchsuchen" placeholder="Aufgaben durchsuchen" />
              <Avatar name="Ada Lovelace" />
              {props.deeds && (
                <>
                  <Button variant="ghost" icon="share" onClick={() => (window.__shared = (window.__shared ?? 0) + 1)}>
                    Teilen
                  </Button>
                  <Button variant="ghost" icon="download" href="#export">
                    Exportieren
                  </Button>
                  <Menu icon="adjustments-horizontal" items={[{ label: "Kompakt" }, { label: "Bequem" }]}>
                    Ansicht
                  </Menu>
                </>
              )}
              {props.more !== false && (
                <Menu
                  label="Space-Menü"
                  items={[
                    { label: "Mitglieder", icon: "users" },
                    { label: "Einstellungen", icon: "settings" },
                  ]}
                />
              )}
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
