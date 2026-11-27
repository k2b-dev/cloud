import { Menu, Nav, Pane, Row, Section, Table, Tabs, Text, Workspace } from "@k2b/ui/v2";

// The settings of a place in Standorte (Venue), tab "Zeiten und Schichten", as in the approved study
// (settings-headings-study v2, A and B, Valentin 27.11.; taste study b): on a wide pane every section's title, summary
// and button stand in a column at the left and its content beside it; on the phone they stand above it. Only
// primitives of @k2b/ui/v2: no class, no style, no CSS of its own.

const hours = [
  { day: "Montag", time: "08:00–16:00", note: "" },
  { day: "Dienstag", time: "08:00–16:00", note: "" },
  { day: "Mittwoch", time: "07:30–16:00", note: "Lieferung ab 7:30" },
  { day: "Donnerstag", time: "08:00–18:00", note: "" },
  { day: "Freitag", time: "08:00–14:00", note: "" },
  { day: "Samstag", time: "09:00–13:00", note: "" },
];

const shifts = [
  ["Inventur", "Mittwoch · 14:00–17:00 · 2–3 Personen"],
  ["Mittagstheke", "Donnerstag · 11:00–14:00 · 3–4 Personen"],
  ["Abendschicht", "Donnerstag · 17:00–21:00 · 2 Personen"],
  ["Frühstück", "Freitag · 08:00–11:00 · 2–3 Personen"],
  ["Brunch", "Samstag · 09:00–13:00 · 3–5 Personen"],
] as const;

const shiftColor = "#c2410c";

export const SettingsScreen = () => (
  <Workspace
    sidebarLabel="Breite der Seitenleiste"
    sidebar={
      <Nav
        title="Standorte"
        icon="coffee"
        groups={[
          {
            label: "Campus-Café Nord",
            items: [
              { label: "Schichtplan", icon: "calendar", href: "#plan" },
              { label: "Meine Schichten", icon: "user", href: "#mine", count: 5 },
              { label: "Feedback", icon: "message", href: "#feedback", count: 7 },
              { label: "Öffentliche Seite", icon: "world", href: "#public" },
            ],
          },
        ]}
        foot={[{ label: "Standorteinstellungen", icon: "settings", current: true }]}
      />
    }
  >
    <Pane
      label="Standorteinstellungen"
      head={
        <Tabs
          label="Bereiche der Einstellungen"
          items={[
            { label: "Allgemein", href: "#general" },
            { label: "Zugriff", href: "#access" },
            { label: "Zeiten und Schichten", href: "#times", current: true },
            { label: "Gefahrenbereich", href: "#danger" },
          ]}
        />
      }
    >
      <Section
        title="Regelmäßige Öffnungszeiten"
        count="6 Tage"
        summary="Gelten jede Woche, außer an abweichenden Tagen. Gäste sehen sie auf der öffentlichen Seite."
        actions={[{ label: "Zeiten", icon: "plus" }]}
      >
        <Table
          label="Regelmäßige Öffnungszeiten"
          rows={hours}
          columns={[
            { title: "Tag", width: { min: 110, default: 150 }, cell: (row) => <Text weight="medium">{row.day}</Text> },
            { title: "Zeiten", width: { min: 110, default: 130 }, cell: (row) => row.time },
            { title: "Hinweis", width: { min: 120, default: 220 }, drop: true, cell: (row) => <Text muted>{row.note}</Text> },
            {
              title: "",
              align: "end",
              width: { min: 56, default: 56 },
              cell: (row) => (
                <Menu
                  label={`Zeiten: ${row.day}`}
                  items={[
                    { label: "Ändern", icon: "pencil" },
                    { label: "Löschen", icon: "trash", danger: true },
                  ]}
                />
              ),
            },
          ]}
        />
      </Section>
      <Section
        title="Abweichende Öffnungszeiten"
        count={1}
        summary="Schließtage und Sonderöffnungen ersetzen die üblichen Zeiten."
        actions={[{ label: "Abweichung", icon: "plus" }]}
      >
        <Row icon="calendar-x" lines={["Do., 24.12.2026", "Geschlossen · Heiligabend"]} />
      </Section>
      <Section
        title="Schichten"
        count={5}
        summary="Wiederkehrende Schichten, für die sich Mitarbeitende eintragen."
        actions={[{ label: "Schicht", icon: "plus" }]}
      >
        {shifts.map(([name, when]) => (
          <Row
            icon="calendar-event"
            color={shiftColor}
            lines={[name, when]}
            end={<Menu label={`Schicht: ${name}`} items={[{ label: "Ändern", icon: "pencil" }]} />}
          />
        ))}
      </Section>
    </Pane>
  </Workspace>
);
