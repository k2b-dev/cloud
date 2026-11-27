import { Cells, Chip, Digest, List, Mark, Nav, Pane, Row, Section, Text, Tiles, Workspace } from "../src/v2";

// Things with a face and people beside what they did: marks by place (sidebar, rows of one and two lines, tiles, a
// sentence), a thumbnail that shows and one that fails, cards with figures, people and a history, the card that
// makes a new thing, an activity, and a key number with its trend.

export const photo = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#b88a52"/><rect x="20" width="3" height="64" fill="#5d4330"/></svg>',
)}`;
export const broken = "data:image/png;base64,AAAA";

const table = { icon: "table", color: "#008f4c" };
const form = { icon: "forms", color: "#c2410c" };

export const IdentityScreen = (props: { onChoice?: (name: string) => void; onCreate?: () => void }) => (
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
          trend={{ values: [22, 30, 27, 36, 31, 38, 41], label: "Offene Aufträge der letzten 7 Tage" }}
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
              trend: { values: [0, 4, 2, 8, 6, 3, 10], label: "Änderungen der letzten 7 Tage" },
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
          <Row mark={{ icon: "photo", color: "#be185d", image: photo }} lines={["Ansicht Front Eiche.jpg", "4,2 MB · heute 09:42"]} />
          <Row mark={{ icon: "photo", color: "#be185d", image: broken }} lines={["Bestand Küche vorher.jpg", "5,6 MB · gestern"]} />
          <Row mark={{ icon: "file-type-pdf", color: "#dc2626", kind: "PDF", label: "PDF" }} lines={["Angebot 2026-118.pdf", "312 KB"]} />
        </List>
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
    </Pane>
  </Workspace>
);
