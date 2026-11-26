import { Bar, List, Pane, Row, Section, Table, Text, Workspace } from "../src/v2";

// The lines and the open row of identity B: a list beside a detail, a section in the detail, a table of the page's
// app and one of another app (its own `color`), each with an open row, the other one with a row chosen for a deed.

type Order = { key: string; name: string; state: string };
const orders: Order[] = [
  { key: "AU-101", name: "Einbauschrank Familie Oswald", state: "offen" },
  { key: "AU-102", name: "Treppe Haus am Hang", state: "offen" },
  { key: "AU-103", name: "Küche Lindqvist", state: "fertig" },
];
const columns = [
  { title: "Auftrag", cell: (row: Order) => row.name },
  { title: "Stand", cell: (row: Order) => row.state },
];

export const LinesFixture = () => (
  <Workspace>
    <Pane.Split>
      <Pane label="Aufträge" width={{ min: 320, default: 400 }}>
        <List label="Aufträge">
          <Row icon="file" lines={["Einbauschrank Familie Oswald"]} time="09:42" />
          <Row icon="file" lines={["Treppe Haus am Hang"]} time="09:10" current />
          <Row icon="file" lines={["Küche Lindqvist"]} time="gestern" />
        </List>
      </Pane>
      <Pane detail label="Auftrag" head={<Bar start={<Text type="lead">Treppe Haus am Hang</Text>} />}>
        <Section title="Positionen">
          <Table label="Positionen" columns={columns} rows={orders} rowKey={(row) => row.key} current="AU-102" />
        </Section>
        <Section title="Aus der Ablage">
          <Table
            label="Belege"
            color="#7c3aed"
            columns={columns}
            rows={orders}
            rowKey={(row) => row.key}
            current="AU-101"
            select={{ selected: ["AU-102"], onChange: () => undefined, all: "Alle Belege", row: (row) => row.name }}
          />
        </Section>
      </Pane>
    </Pane.Split>
  </Workspace>
);
