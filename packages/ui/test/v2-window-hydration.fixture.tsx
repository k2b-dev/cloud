import { List, Nav, type NavItem, Pane, Row, Table, Workspace } from "../src/v2";

// Lists and tables with a window (`createVirtualWindow`), rendered on the server and hydrated in the browser, where
// the development build of Solid throws on any node it cannot find (review of #4211). The test sets them up by `kind`:
// - `groups`: a list of 60 entries under a head every 7, so the first page (40 entries) holds group heads;
// - `forty` and `fortyone`: a list of 40 entries (no window) and of 41 (a window), the boundary of `SERVER_ROWS`;
// - `table`: a grouped table of 38 rows in 3 groups: 41 entries, so the server sends 3 heads and 37 rows;
// - `phone`: the same table with its phone form;
// - `nav`: a sidebar of 1,000 tables whose current one is the 700th.
export type Kind = "groups" | "forty" | "fortyone" | "table" | "phone" | "nav";

const entries = (count: number) => Array.from({ length: count }, (_, index) => ({ key: `e${index + 1}`, title: `Eintrag ${index + 1}` }));
const rows = Array.from({ length: 38 }, (_, index) => ({ id: `r${index + 1}`, name: `Zeile ${index + 1}`, state: index % 2 ? "offen" : "erledigt" }));
const third = (index: number) => Math.floor(index / 13) + 1;

const Rows = (props: { count: number; groups?: boolean }) => (
  <List
    label="Einträge"
    items={entries(props.count)}
    rowKey={(entry) => entry.key}
    group={
      props.groups
        ? (entry) => {
            const day = Math.floor((Number(entry.key.slice(1)) - 1) / 7) + 1;
            return { key: `d${day}`, label: `Tag ${day}`, count: "7" };
          }
        : undefined
    }
    row={(entry) => <Row lines={[entry.title, "Zweite Zeile"]} href={`#${entry.key}`} />}
  />
);

const Rows38 = (props: { phone?: boolean }) => (
  <Table
    label="Zeilen"
    rows={rows}
    rowKey={(row) => row.id}
    group={(row) => {
      const at = third(Number(row.id.slice(1)) - 1);
      return { key: `g${at}`, head: () => `Gruppe ${at}`, meta: "13" };
    }}
    columns={[
      { title: "Zeile", cell: (row) => <span data-cell={row.id}>{row.name}</span>, width: { min: 120, default: 200 } },
      { title: "Stand", cell: (row) => row.state, width: { min: 80, default: 120 } },
    ]}
    phone={props.phone ? (row) => ({ lines: [row.name, row.state] }) : undefined}
  />
);

const tables: NavItem[] = Array.from({ length: 1000 }, (_, index) => ({
  label: `Tabelle ${index + 1}`,
  icon: "table",
  href: `#t${index + 1}`,
  current: index === 699,
}));

export const Fixture = (props: { kind: Kind }) => (
  <Workspace sidebar={props.kind === "nav" ? <Nav title="Grids" icon="table" groups={[{ label: "Tabellen", items: tables }]} /> : undefined}>
    <Pane label="Inhalt">
      {props.kind === "groups" ? (
        <Rows count={60} groups />
      ) : props.kind === "forty" ? (
        <Rows count={40} />
      ) : props.kind === "fortyone" ? (
        <Rows count={41} />
      ) : props.kind === "table" ? (
        <Rows38 />
      ) : props.kind === "phone" ? (
        <Rows38 phone />
      ) : (
        <Row lines={["Inhalt"]} />
      )}
    </Pane>
  </Workspace>
);
