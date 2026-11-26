import { Bar, Input, List, Pane, Path, Row, Text, Workspace } from "../src/v2";

/**
 * A head that shows where the page stands and holds a search, as a tree or a folder does: on the phone the path gives
 * way to the host's bar, so in a host with a search the head holds nothing to show.
 */
export function PathAndSearch() {
  return (
    <Workspace
      head={
        <Bar
          start={<Path label="Ort" items={[{ label: "Ablage", href: "#" }, { label: "Verträge" }]} />}
          // no placeholder: a search shows its name while empty
          end={<Input type="search" icon="search" label="In Verträgen suchen" />}
        />
      }
    >
      <Pane label="Verträge">
        <List label="Verträge">
          <Row icon="file-text" lines={["Mietvertrag Halle 3"]} />
          <Row icon="file-text" lines={["Wartungsvertrag Aufzug"]} />
        </List>
      </Pane>
    </Workspace>
  );
}

/** A Space of a long name: its open entry leads back to it. */
export const longSpace = "Arbeitsgruppe Nachhaltige Beschaffung und Lieferketten im Landkreis Ortenau – Protokolle und Beschlüsse 2026";

/** An open entry on the phone, whose way back names its list: a short name, or a Space of about a hundred characters. */
export function DetailBack(props: { back: string }) {
  return (
    <Workspace detail>
      <Pane.Split>
        <Pane label="Einträge">
          <List label="Einträge">
            <Row icon="file-text" lines={["Protokoll 12. November"]} />
          </List>
        </Pane>
        <Pane
          detail
          label="Protokoll"
          back={{ label: props.back, href: "#" }}
          head={<Bar start={<Text type="lead">Protokoll 12. November</Text>} />}
        >
          <Text type="body">Beschlüsse und Aufgaben.</Text>
        </Pane>
      </Pane.Split>
    </Workspace>
  );
}

/** A page with a head search whose detail is open: on the phone the detail is the page and the head gives way. */
export function DetailWithSearch() {
  return (
    <Workspace
      detail
      head={<Bar start={<Text type="lead">Verträge</Text>} end={<Input type="search" icon="search" label="In Verträgen suchen" />} />}
    >
      <Pane.Split>
        <Pane label="Verträge">
          <List label="Verträge">
            <Row icon="file-text" lines={["Mietvertrag Halle 3"]} />
          </List>
        </Pane>
        <Pane
          detail
          label="Mietvertrag"
          back={{ label: "Verträge", href: "#" }}
          head={<Bar start={<Text type="lead">Mietvertrag Halle 3</Text>} />}
        >
          <Text type="body">Laufzeit bis 2029.</Text>
        </Pane>
      </Pane.Split>
    </Workspace>
  );
}
