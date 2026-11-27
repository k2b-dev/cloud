import { LocaleProvider } from "../src/intl/locale";
import { Bar, Input, Nav, Pane, Table, Text, Workspace } from "../src/v2";

// Two workspaces of Grids' kind, each in a box of its own (`.case`), for the widths a column keeps:
// - "queries": a list of 320 to 360 px whose head is one search, beside the query, a main column that keeps 640 px
//   (`min`). The sidebar stays a column only where it has its default beside both: 248 + 1 + 320 + 1 + 640 = 1210 px.
// - "tables": a list of 480 to 520 px with a table, whose head is a search, beside a column without a width.

const items = [
  { icon: "table", label: "Tabellen", href: "#tables" },
  { icon: "search", label: "Abfragen", href: "#queries" },
];

const rows = [
  { name: "Aufträge 2026", owner: "Mira Solberg", changed: "heute" },
  { name: "Lieferanten", owner: "Jonas Kern", changed: "gestern" },
  { name: "Lager Nord", owner: "Felix Thal", changed: "12. Nov." },
];

export function Fixture() {
  return (
    <LocaleProvider locale="de">
      <div class="case" data-case="queries">
        <Workspace
          sidebarLabel="Breite der Seitenleiste"
          sidebar={<Nav title="Grids" icon="table" groups={[{ items: items.map((item, index) => ({ ...item, current: index === 1 })) }]} />}
          head={
            <Bar
              start={
                <Text type="row" weight="strong">
                  Abfragen
                </Text>
              }
            />
          }
        >
          <Pane.Split>
            <Pane
              label="Abfragen"
              width={{ min: 320, default: 360 }}
              head={<Bar start={<Input type="search" label="Abfragen suchen" />} />}
            >
              <Text>Zwölf gespeicherte Abfragen.</Text>
            </Pane>
            <Pane label="Abfrage" min={640}>
              <Text>Die Abfrage und ihr Ergebnis.</Text>
            </Pane>
          </Pane.Split>
        </Workspace>
      </div>
      <div class="case" data-case="tables">
        <Workspace
          sidebarLabel="Breite der Seitenleiste"
          sidebar={<Nav title="Grids" icon="table" groups={[{ items: items.map((item, index) => ({ ...item, current: index === 0 })) }]} />}
          head={
            <Bar
              start={
                <Text type="row" weight="strong">
                  Tabellen
                </Text>
              }
            />
          }
        >
          <Pane.Split>
            <Pane
              label="Tabellen"
              width={{ min: 480, default: 520 }}
              head={<Bar start={<Input type="search" label="Tabellen suchen" />} />}
            >
              <Table
                label="Alle Tabellen"
                rows={rows}
                columns={[
                  { title: "Name", cell: (row) => row.name },
                  { title: "Besitzer", cell: (row) => row.owner },
                  { title: "Geändert", cell: (row) => row.changed },
                ]}
                phone={(row) => ({ lines: [row.name, row.owner], time: row.changed })}
              />
            </Pane>
            <Pane label="Tabelle">
              <Text>Die offene Tabelle.</Text>
            </Pane>
          </Pane.Split>
        </Workspace>
      </div>
    </LocaleProvider>
  );
}
