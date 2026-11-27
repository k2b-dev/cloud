import { LocaleProvider } from "../src/intl/locale";
import { Bar, Button, Facts, Nav, Pane, Row, Section, Table, Text, Workspace } from "../src/v2";

// The context column (`Pane side`) in its two places, as the test sets them up through `kind`:
// - `form`: a main column and beside it a context column of 280 to 340 px; it stands beside from 400 + 340 = 740 px of
//   the split, so at a window of 1024 px (a split of ~700 px beside the sidebar) it gives way;
// - `table`: the same with `side={{ from: 1400 }}`, for a main column that needs its room (a table): beside only on a
//   large screen;
// - `detail`: a list that keeps 640 px and an open detail that grows on a large screen: under its one head a split of
//   what it is (left) and who and what happened (right, `Pane side` of 320 px). It stands in two columns from
//   400 + 320 = 720 px of the detail, from a window of ~1680 px.
// The test sets the window like Cloud's shell (66 px beside the workspace) and reads where the columns stand.

// - `short`: `form` with two rows only, so the split has room left below when the context column gives way;
// - `tall`: `table` with 200 rows, far taller than the window: beside its context column, the main column scrolls;
// - `three`: a list, its reader and an info column (`Pane side`): not a main column with its context, so it stays as
//   every split is: three columns beside each other, the info column counted in the workspace's room.
export type Kind = "form" | "short" | "tall" | "table" | "detail" | "three";

const items = [
  { icon: "plug", label: "Quellen", href: "#quellen" },
  { icon: "settings", label: "Einstellungen", href: "#einstellungen" },
];
const source = (index: number) => ({
  id: `q${index}`,
  name: `Quelle ${index + 1}`,
  kind: index % 2 ? "Webhook" : "Abruf",
  seen: `09:${String(40 - (index % 40)).padStart(2, "0")}`,
});
const rows = Array.from({ length: 14 }, (_, index) => source(index));
const many = Array.from({ length: 200 }, (_, index) => source(index));

const Sources = (props: { few?: boolean; many?: boolean }) => (
  <Table
    label="Quellen"
    rows={props.few ? rows.slice(0, 2) : props.many ? many : rows}
    rowKey={(row) => row.id}
    columns={[
      { title: "Quelle", width: { min: 160, default: 240 }, cell: (row) => row.name },
      { title: "Art", width: { min: 90, default: 140 }, cell: (row) => row.kind },
      { title: "Zuletzt", cell: (row) => row.seen },
    ]}
  />
);

const Context = () => (
  <>
    <Section icon="info-circle" title="Angaben">
      <Facts
        items={[
          { label: "Quellen", value: "14" },
          { label: "Gestört", value: "1" },
        ]}
      />
    </Section>
    <Section icon="history" title="Zuletzt">
      <Row icon="plug" lines={["Quelle 1 angelegt", "Ada Renz · gestern"]} />
      <Row icon="plug" lines={["Quelle 2 geändert", "Felix Thal · Mo."]} />
    </Section>
  </>
);

export function Fixture(props: { kind: Kind }) {
  return (
    <LocaleProvider locale="de">
      <Workspace
        sidebarLabel="Breite der Seitenleiste"
        sidebar={
          <Nav title="Pulse" icon="activity" groups={[{ items: items.map((item, index) => ({ ...item, current: index === 0 })) }]} />
        }
        head={<Bar start={<Text type="lead">Quellen</Text>} end={<Button variant="primary">Neue Quelle</Button>} />}
      >
        {props.kind === "detail" ? (
          <Pane.Split>
            <Pane label="Haupt" width={{ min: 560, default: 640 }}>
              <Sources />
            </Pane>
            <Pane detail label="Quelle 1" back={{ label: "Quellen", href: "#" }} head={<Bar start={<Text type="lead">Quelle 1</Text>} />}>
              <Pane.Split>
                <Pane label="Was sie ist">
                  <Section icon="plug" title="Verbindung">
                    <Facts
                      items={[
                        { label: "Art", value: "Abruf alle 5 Minuten" },
                        { label: "Adresse", value: "api.example.org/v2/lager" },
                      ]}
                    />
                  </Section>
                </Pane>
                <Pane side label="Kontext" width={{ min: 280, default: 320 }}>
                  <Context />
                </Pane>
              </Pane.Split>
            </Pane>
          </Pane.Split>
        ) : props.kind === "three" ? (
          <Pane.Split>
            <Pane label="Liste" width={{ min: 280, default: 360 }}>
              <Text>Nachrichten</Text>
            </Pane>
            <Pane label="Haupt">
              <Sources />
            </Pane>
            <Pane side label="Kontext" width={{ min: 240, default: 300 }}>
              <Context />
            </Pane>
          </Pane.Split>
        ) : (
          <Pane.Split>
            <Pane label="Haupt">
              <Sources few={props.kind === "short"} many={props.kind === "tall"} />
            </Pane>
            <Pane
              side={props.kind === "table" || props.kind === "tall" ? { from: 1400 } : true}
              label="Kontext"
              width={{ min: 280, default: 340 }}
            >
              <Context />
            </Pane>
          </Pane.Split>
        )}
      </Workspace>
    </LocaleProvider>
  );
}
