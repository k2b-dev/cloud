import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { Menu, Pane, Table, Workspace } from "../src/v2";

// A table whose rows open their entry, with a "…" at the end of each row: what the row's menu chooses must stay the
// menu's, never also open the row (Files' shares: "Link widerrufen").

declare global {
  interface Window {
    __k2Mounted?: boolean;
    /** The rows opened, in order. */
    __k2Opened?: string[];
    /** The menu entries chosen, in order. */
    __k2Chosen?: string[];
  }
}

const rows = [
  { id: "a", name: "Unterlagen Lindqvist" },
  { id: "b", name: "Fotos Baustelle" },
];

const RowMenu = () => {
  const [, setTick] = createSignal(0);
  window.__k2Opened = [];
  window.__k2Chosen = [];
  return (
    <Workspace>
      <Pane label="Freigaben">
        <Table
          label="Freigaben"
          rows={rows}
          rowKey={(row) => row.id}
          open={(row) => ({
            onOpen: () => {
              window.__k2Opened!.push(row.id);
              setTick((tick) => tick + 1);
            },
          })}
          columns={[
            { title: "Name", cell: (row) => row.name },
            {
              title: "Aktionen",
              width: { min: 48, default: 48 },
              align: "end",
              cell: (row) => (
                <Menu
                  label={`Aktionen für ${row.name}`}
                  items={[{ label: "Link widerrufen", icon: "link-off", onClick: () => window.__k2Chosen!.push(row.id) }]}
                />
              ),
            },
          ]}
        />
      </Pane>
    </Workspace>
  );
};

render(() => <RowMenu />, document.getElementById("root")!);
window.__k2Mounted = true;
