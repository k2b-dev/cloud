import { Bar, Input, List, Pane, Path, Row, Workspace } from "../src/v2";

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
          end={<Input type="search" icon="search" label="In Verträgen suchen" placeholder="In Verträgen suchen" />}
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
