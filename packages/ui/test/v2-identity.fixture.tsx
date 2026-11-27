import { Avatar, Cells, Chip, Digest, List, Mark, Nav, Pane, Row, Section, Table, Text, Tiles, Workspace } from "../src/v2";

// teams of 4, 8 and 30 people in a column of 90 px: the stack shows what it holds whole and counts the rest; teams of
// 2 and 3 show everyone
const names = ["Felix Thal", "Jonas Kern", "Mira Solberg", "Tom Oswald", "Sami Yilmaz", "Lena Hartwig", "Ada Renz", "Jana Berger"];
const crew = (count: number) => Array.from({ length: count }, (_, index) => ({ name: `${names[index % names.length]} ${index + 1}` }));
export const teams = [
  { name: "Montage", people: crew(4), orders: 12 },
  { name: "Werkstatt", people: crew(8), orders: 41 },
  { name: "Alle Monteure und Aushilfen der Saison", people: crew(30), orders: 1284 },
  // everyone shows: the stack ends at its last face, without room for a count it does not need (W3)
  { name: "Büro", people: [{ name: "Charles Augustus Montgomery III" }, { name: "🦊 Fuchs Bau" }], orders: 3 },
  { name: "Lager", people: crew(3), orders: 7 },
];

// Things with a face and people beside what they did: marks by place (sidebar, rows of one and two lines, tiles, a
// sentence), a thumbnail that shows and one that fails, cards with figures, people and a history, the card that
// makes a new thing, an activity, and a key number with its trend.

export const photo = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#b88a52"/><rect x="20" width="3" height="64" fill="#5d4330"/></svg>',
)}`;
export const broken = "data:image/png;base64,AAAA";

const table = { icon: "table", color: "#008f4c" };
const form = { icon: "forms", color: "#c2410c" };

export const IdentityScreen = (props: { onChoice?: (name: string) => void; onCreate?: () => void; onOpen?: (hash: string) => void }) => (
  <Workspace
    sidebar={
      <Nav
        title="Grids"
        icon="table"
        groups={[
          {
            label: "Bases",
            items: [
              { label: "Werkstatt", icon: "tool", color: "#c2410c", current: true },
              { label: "Lager Nord", icon: "building-warehouse", color: "#0f766e", dot: "warn" },
              { label: "Papierkorb", icon: "trash" },
            ],
          },
        ]}
      />
    }
  >
    <Pane label="Werkstatt">
      <Cells>
        <Cells.Cell
          icon="clipboard-list"
          label="Offene Aufträge"
          value="41"
          meta="+12 heute"
          trend={{ values: [22, 30, 27, 36, 31, 38, 41], label: "Offene Aufträge: in 7 Tagen von 22 auf 41 gestiegen" }}
        />
        <Cells.Cell icon="calendar-due" label="Heute fällig" value="9" />
      </Cells>
      <Section title="Bases" count={2}>
        <Tiles
          variant="card"
          label="Bases"
          items={[
            {
              icon: "tool",
              color: "#c2410c",
              title: "Werkstatt",
              meta: "Aufträge, Ersatzteile und Termine",
              href: "#werkstatt",
              stats: [
                { icon: "table", label: "6 Tabellen" },
                { icon: "alert-circle", label: "8 knapp", status: "warn" },
                { label: "3 Anträge", yours: true },
              ],
              people: [
                { name: "Felix Thal" },
                { name: "Jonas Kern" },
                { name: "Mira Solberg" },
                { name: "Tom Oswald" },
                { name: "Sami Yilmaz" },
              ],
              foot: "Felix · vor 2 Min",
              trend: { values: [0, 4, 2, 8, 6, 3, 10], label: "Werkstatt: in 7 Tagen von 0 auf 10 Änderungen gestiegen" },
            },
            {
              icon: "building-warehouse",
              color: "#0f766e",
              title: "Lager Nord mit einem sehr langen Namen, der auf der Karte ausblendet",
              meta: "Bestand, Einlieferungen, Inventur und noch viel mehr, was nicht passt",
              href: "#lager",
              stats: [{ icon: "table", label: "7 Tabellen" }],
            },
          ]}
          create={{
            title: "Neue Base",
            meta: "Leer beginnen oder aus einer Vorlage",
            onClick: () => props.onCreate?.(),
            choices: [
              { label: "CRM", onClick: () => props.onChoice?.("CRM") },
              { label: "Lager", onClick: () => props.onChoice?.("Lager") },
            ],
          }}
        />
      </Section>
      <Section title="Dateien" count={4}>
        <List label="Dateien">
          <Row mark={{ ...table }} lines={["Aufträge"]} time="vor 2 Min" />
          <Row mark={{ icon: "sun", color: "#fef08a", kind: "GELB" }} lines={["Sommerfest Plakat"]} time="gestern" />
          <Row mark={{ icon: "photo", color: "#be185d", image: photo }} lines={["Ansicht Front Eiche.jpg", "4,2 MB · heute 09:42"]} />
          <Row mark={{ icon: "photo", color: "#be185d", image: broken }} lines={["Bestand Küche vorher.jpg", "5,6 MB · gestern"]} />
          <Row mark={{ icon: "file-type-pdf", color: "#dc2626", kind: "PDF", label: "PDF" }} lines={["Angebot 2026-118.pdf", "312 KB"]} />
          {/* a person among the files (who shares them) starts on their edge */}
          <Row avatar={{ name: "Jana Berger" }} lines={["Jana Berger", "teilt 4 Dateien"]} />
        </List>
      </Section>
      {/* who or what a thing is, without a picture: a data list and a table of bases keep the mark's 24 */}
      <Section title="Bases" count={2}>
        <List label="Bases">
          <Row mark={{ ...table }} lines={["Aufträge"]} time="vor 2 Min" />
          <Row mark={{ ...form }} lines={["Auftrag annehmen", "Formular · 12 Felder"]} />
        </List>
        <Table
          label="Tabellen"
          rows={[
            { key: "a", name: "Aufträge", rows: 318 },
            { key: "k", name: "Kunden", rows: 42 },
          ]}
          columns={[
            { title: "Tabelle", width: { min: 140, default: 200 }, mark: () => table, cell: (row) => row.name },
            { title: "Einträge", width: { min: 80, default: 90 }, align: "end", cell: (row) => String(row.rows) },
          ]}
        />
      </Section>
      <Section title="Aktivität">
        <Digest
          label="Aktivität"
          activity={[
            {
              person: { name: "Felix Thal" },
              text: (
                <>
                  <Text weight="strong">Felix Thal</Text> hat 3 Einträge in <Mark {...table} />
                  <Text weight="strong">Aufträge</Text> geändert, und dieser Satz ist lang genug, um auf schmalen Spalten umzubrechen
                </>
              ),
              place: "Werkstatt",
              time: "09:42",
              href: "#auftraege",
              // the thing opens in place, as a page with islands does; the link still works before the page is live
              onNavigate: (event) => props.onOpen?.(new URL(event.href, location.href).hash),
            },
            {
              person: { name: "Webformular", initials: "W", color: "#475569" },
              text: (
                <>
                  Neuer Eintrag über <Mark {...form} />
                  <Text weight="strong">Auftrag annehmen</Text>
                </>
              ),
              time: "09:38",
            },
          ]}
        />
      </Section>
      <Section title="Status">
        <List>
          <Row icon="circle-check" lines={["Nachbestellung"]} marks={<Chip status="bad">Fehler</Chip>} />
        </List>
      </Section>
      <Section title="Teams" count={3}>
        <Table
          label="Teams"
          rows={teams}
          columns={[
            { title: "Team", width: { min: 140, default: 180 }, cell: (row) => row.name },
            { title: "Leute", width: { min: 90, default: 90 }, cell: (row) => <Avatar.Stack people={row.people} /> },
            { title: "Aufträge", width: { min: 80, default: 90 }, align: "end", cell: (row) => String(row.orders) },
          ]}
        />
      </Section>
    </Pane>
  </Workspace>
);
