import { Avatar, Bar, Button, Chip, Icon, Inline, Input, Nav, Pane, Path, StatusRow, Table, Text, Workspace } from "@k2b/ui/v2";
import { createSignal } from "solid-js";

// The large table of Grids, as in the approved mockup (tabelle-grids.html): 34 orders in 11 columns, grouped by state.
// Only primitives of @k2b/ui/v2. It is an island so the boxes select rows and the status row turns into the bar of
// what can be done with them; hover, the sticky column and its edge come from the stylesheet.

type Person = { name: string; initials: string; color: string };
type State = "open" | "work" | "done";
type Order = {
  key: string;
  name: string;
  number: string;
  state: State;
  person: Person;
  tags: readonly (readonly [string, string])[];
  quantity: number;
  amount: string;
  due: string;
  checked: boolean;
  document: string;
  note: string;
};

const people: Person[] = [
  { name: "Mira Solberg", initials: "MS", color: "#0f766e" },
  { name: "Jule Amsel", initials: "JA", color: "#7c3aed" },
  { name: "Henrik Brandt", initials: "HB", color: "#b45309" },
  { name: "Ada Renz", initials: "AR", color: "#be123c" },
];
const tag = {
  eiche: ["Eiche", "#b45309"],
  eilig: ["Eilig", "#be123c"],
  lack: ["Lack", "#0f766e"],
  montage: ["Montage", "#2563eb"],
  reparatur: ["Reparatur", "#7c3aed"],
} as const;
const notes = [
  "Maß nehmen am Dienstag",
  "Holz bestellt, Lieferung KW 49",
  "–",
  "Kunde will Muster sehen",
  "Lack Seidenmatt RAL 9010",
  "–",
  "Termin mit Bauleitung abstimmen",
];

// [name, state, tags, quantity, amount, due day]
const raw: [string, State, (keyof typeof tag)[], number, string, string][] = [
  ["Einbauschrank Familie Oswald", "open", ["eiche", "eilig"], 1, "180,50 €", "03.11.2026"],
  ["Treppe Haus am Hang", "open", ["lack"], 8, "617,00 €", "05.11.2026"],
  ["Küche Lindqvist", "open", ["eilig"], 15, "1.054,00 €", "07.11.2026"],
  ["Esstisch Eiche massiv", "open", ["montage", "eiche"], 22, "1.491,00 €", "09.11.2026"],
  ["Regalwand Praxis Dr. Kern", "open", ["reparatur"], 6, "1.928,50 €", "11.11.2026"],
  ["Haustür Bauhof Nordtal", "open", ["eiche"], 13, "2.365,00 €", "13.11.2026"],
  ["Fensterbänke Stadtwerke", "open", ["lack", "montage"], 20, "2.802,00 €", "15.11.2026"],
  ["Garderobe Kita Sonnenhof", "open", ["eilig"], 4, "3.239,00 €", "17.11.2026"],
  ["Bett mit Schubladen", "open", ["montage"], 11, "3.676,50 €", "19.11.2026"],
  ["Sitzbank Wintergarten", "open", ["reparatur", "lack"], 18, "4.113,00 €", "21.11.2026"],
  ["Theke Café Mühle", "open", ["eiche"], 2, "350,00 €", "23.11.2026"],
  ["Schreibtisch Architekturbüro", "open", ["lack"], 9, "787,00 €", "25.11.2026"],
  ["Kommode Restaurierung", "work", ["eilig", "reparatur"], 16, "1.224,50 €", "03.11.2026"],
  ["Dielenboden Altbau", "work", ["montage"], 23, "1.661,00 €", "05.11.2026"],
  ["Schiebetür Bad", "work", ["reparatur"], 7, "2.098,00 €", "07.11.2026"],
  ["Vitrine Museum Auental", "work", ["eiche", "eilig"], 14, "2.535,00 €", "09.11.2026"],
  ["Gartenhaus Tür", "work", ["lack"], 21, "2.972,50 €", "11.11.2026"],
  ["Bücherregal Bibliothek", "work", ["eilig"], 5, "3.409,00 €", "13.11.2026"],
  ["Werkbank Schule", "work", ["montage", "eiche"], 12, "3.846,00 €", "15.11.2026"],
  ["Couchtisch Nussbaum", "work", ["reparatur"], 19, "4.283,00 €", "17.11.2026"],
  ["Treppengeländer", "work", ["eiche"], 3, "520,50 €", "19.11.2026"],
  ["Wandvertäfelung Kanzlei", "done", ["lack", "montage"], 10, "957,00 €", "03.10.2026"],
  ["Spielturm Kita", "done", ["eilig"], 17, "1.394,00 €", "05.10.2026"],
  ["Sauna Bänke", "done", ["montage"], 1, "1.831,00 €", "07.10.2026"],
  ["Hochbeet Schule", "done", ["reparatur", "lack"], 8, "2.268,50 €", "09.10.2026"],
  ["Fensterläden Pfarrhaus", "done", ["eiche"], 15, "2.705,00 €", "11.10.2026"],
  ["Kleiderschrank Dachschräge", "done", ["lack"], 22, "3.142,00 €", "13.10.2026"],
  ["Empfangstresen Praxis", "done", ["eilig", "reparatur"], 6, "3.579,00 €", "15.10.2026"],
  ["Küchenfronten Lack", "done", ["montage"], 13, "4.016,50 €", "17.10.2026"],
  ["Badmöbel Eiche", "done", ["reparatur"], 20, "253,00 €", "19.10.2026"],
  ["Tischplatte Ahorn", "done", ["eiche", "eilig"], 4, "690,00 €", "21.10.2026"],
  ["Hocker Serie 12", "done", ["lack"], 11, "1.127,00 €", "23.10.2026"],
  ["Schuhschrank Flur", "done", ["eilig"], 18, "1.564,50 €", "25.10.2026"],
  ["Konferenztisch", "done", ["montage", "eiche"], 2, "2.001,00 €", "27.10.2026"],
];

const orders: Order[] = raw.map(([name, state, tags, quantity, amount, due], index) => {
  const year = state === "done" ? "2610" : "2611";
  const serial = String(100 + index).padStart(4, "0");
  return {
    key: `AU-${year}-${serial}`,
    name,
    number: `AU-${year}-${serial}`,
    state,
    person: people[index % people.length]!,
    tags: tags.map((name) => tag[name]),
    quantity,
    amount,
    due,
    checked: state === "done" || index % 4 === 1,
    document: `RE-${year}-${String(300 + index).padStart(4, "0")}`,
    note: notes[index % notes.length]!,
  };
});

const groups: Record<State, { label: string; meta: string; chip: () => ReturnType<typeof Chip> }> = {
  open: { label: "Offen", meta: "12 · 22.603,50 €", chip: () => <Chip status="warn">Offen</Chip> },
  work: {
    label: "In Arbeit",
    meta: "9 · 22.549,50 €",
    chip: () => (
      <Chip yours dot>
        In Arbeit
      </Chip>
    ),
  },
  done: { label: "Erledigt", meta: "13 · 25.528,50 €", chip: () => <Chip status="ok">Erledigt</Chip> },
};
const stateChip: Record<State, () => ReturnType<typeof Chip>> = {
  open: () => <Chip status="warn">offen</Chip>,
  work: () => (
    <Chip yours dot>
      in Arbeit
    </Chip>
  ),
  done: () => <Chip status="ok">erledigt</Chip>,
};

export default function TableScreen() {
  const [selected, setSelected] = createSignal<readonly string[]>([]);
  const count = () => selected().length;
  return (
    <Workspace
      sidebarLabel="Breite der Seitenleiste"
      primary={{ label: "Auftrag", icon: "plus" }}
      sidebar={
        <Nav
          title="Grids"
          icon="table"
          groups={[
            {
              label: "Werkstatt",
              items: [
                { label: "Aufträge", icon: "table", count: 34, current: true },
                { label: "Material", icon: "table", count: 128 },
                { label: "Kunden", icon: "table", count: 412 },
              ],
            },
            { label: "Büro", items: [{ label: "Rechnungen", icon: "table" }] },
          ]}
        />
      }
      head={
        <Bar
          start={<Path label="Ort" items={[{ label: "Werkstatt", href: "#werkstatt" }, { label: "Aufträge" }]} />}
          end={
            <>
              <Input type="search" icon="search" placeholder="Suchen" label="Suchen" />
              <Button variant="primary" icon="plus">
                Auftrag
              </Button>
            </>
          }
        />
      }
    >
      <Pane
        label="Aufträge"
        status={
          <StatusRow
            lead="34 Aufträge"
            facts={[{ before: "Summe", value: "70.681,50 €" }, { before: "12 offen" }]}
            filters={
              <Inline>
                <Chip icon="layers-subtract" pressed onClick={() => undefined}>
                  Nach Status
                </Chip>
                <Chip pressed onClick={() => undefined}>
                  Verantwortlich: alle
                </Chip>
                <Chip icon="filter" onClick={() => undefined}>
                  Filter
                </Chip>
              </Inline>
            }
            selection={
              count() > 0
                ? {
                    count: `${count()} ausgewählt`,
                    actions: [
                      { label: "Status ändern", icon: "arrows-exchange" },
                      { label: "Exportieren", icon: "download" },
                      { label: "Löschen", icon: "trash" },
                    ],
                    clear: { label: "Auswahl aufheben", onClick: () => setSelected([]) },
                  }
                : undefined
            }
          />
        }
      >
        <Table
          label="Aufträge"
          rows={orders}
          rowKey={(order) => order.key}
          current="AU-2611-0102"
          sticky
          select={{ selected: selected(), onChange: setSelected, all: "Alle Aufträge", row: (order) => order.name }}
          group={(order) => ({
            key: order.state,
            head: groups[order.state].chip(),
            meta: groups[order.state].meta,
            count: groups[order.state].meta.split(" · ")[0],
          })}
          sort={{ column: 7, direction: "ascending" }}
          phone={(order) => ({
            lines: [order.name, `${order.number} · fällig ${order.due}`],
            avatar: order.person,
            time: order.amount,
          })}
          columns={[
            { title: "Auftrag", width: { min: 160, default: 260 }, cell: (order) => <Text weight="medium">{order.name}</Text> },
            { title: "Nummer", width: { min: 100, default: 132 }, cell: (order) => order.number },
            { title: "Status", width: { min: 100, default: 120 }, cell: (order) => stateChip[order.state]() },
            {
              title: "Verantwortlich",
              width: { min: 120, default: 176 },
              cell: (order) => (
                <Inline>
                  <Avatar {...order.person} />
                  {order.person.name}
                </Inline>
              ),
            },
            {
              title: "Tags",
              width: { min: 120, default: 188 },
              cell: (order) => (
                <Inline>
                  {order.tags.map(([name, color]) => (
                    <Chip tag color={color}>
                      {name}
                    </Chip>
                  ))}
                </Inline>
              ),
            },
            { title: "Menge", align: "end", width: { min: 64, default: 88 }, cell: (order) => String(order.quantity) },
            { title: "Betrag", align: "end", width: { min: 96, default: 120 }, cell: (order) => order.amount },
            { title: "Fällig", width: { min: 96, default: 112 }, cell: (order) => order.due },
            {
              title: "Geprüft",
              width: { min: 72, default: 84 },
              cell: (order) =>
                order.checked ? (
                  <Text>
                    <Icon name="circle-check" tone="ok" /> ja
                  </Text>
                ) : (
                  <Text type="meta">nein</Text>
                ),
            },
            { title: "Beleg", width: { min: 100, default: 140 }, cell: (order) => <Text href="#beleg">{order.document}</Text> },
            {
              title: "Notiz",
              width: { min: 120, default: 260 },
              cell: (order) => (order.note === "–" ? <Text type="meta">–</Text> : order.note),
            },
          ]}
        />
      </Pane>
    </Workspace>
  );
}
