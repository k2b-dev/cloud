import {
  Avatar,
  Bar,
  Button,
  Choice,
  Field,
  Input,
  List,
  Nav,
  Pane,
  RecordHead,
  Row,
  Section,
  Select,
  Tabs,
  Text,
  Workspace,
} from "@k2b/ui/v2";

// The settings screens of the taste study (v2-taste-study v2, screens a and b), built only from @k2b/ui/v2 primitives:
// no class, no style, no CSS of their own. They show what a settings page inherits from the primitives: a section
// head in a column of its own on a wide pane, actions as framed buttons with a verb, rows that carry their sign and
// the control that changes them, and a choice of a few options as connected cards.

const grids = "#16a34a";
const roles = ["Verwalten", "Bearbeiten", "Ansehen"] as const;

const GridsNav = () => (
  <Nav
    title="Grids"
    icon="table"
    groups={[
      {
        items: [
          { label: "Übersicht", icon: "layout-grid" },
          { label: "Abfrage", icon: "code" },
        ],
      },
      {
        label: "Annahme",
        items: [
          { label: "Aufträge", icon: "table", count: 128 },
          { label: "Auftrag annehmen", icon: "forms" },
          { label: "Kunden", icon: "table", count: 342 },
        ],
      },
      {
        label: "Lager",
        items: [
          { label: "Ersatzteile", icon: "table", count: 642 },
          { label: "Lieferanten", icon: "table", count: 38 },
        ],
      },
      {
        label: "Auswertung",
        items: [
          { label: "Offene Aufträge", icon: "filter", count: 17 },
          { label: "Diese Woche", icon: "calendar", count: 9 },
          { label: "Rechnung", icon: "file-invoice" },
        ],
      },
    ]}
    foot={[
      { label: "Papierkorb", icon: "trash" },
      { label: "Einstellungen", icon: "settings", current: true },
    ]}
  />
);

const role = (person: string, value: (typeof roles)[number]) => (
  <Select label={`Rolle von ${person}`} options={roles} value={value} onChange={() => undefined} />
);

/** Grids › Werkstatt › Einstellungen › Zugriff (study screen a). */
export const GridsAccessScreen = () => (
  <Workspace
    sidebarLabel="Breite der Seitenleiste"
    sidebar={<GridsNav />}
    head={<Bar start={<RecordHead name="Werkstatt" kinds={["Base"]} />} />}
  >
    <Pane
      label="Zugriff"
      head={
        <Tabs
          label="Einstellungen der Base"
          items={[{ label: "Allgemein" }, { label: "Zugriff", current: true }, { label: "Automationen" }, { label: "Gefahrenbereich" }]}
        />
      }
    >
      <Section form title="Personen und Gruppen" count={12} summary="Wer diese Base öffnen, bearbeiten oder verwalten darf.">
        <Field.Row>
          <Field label="Einladen">
            <Input placeholder="Name, E-Mail-Adresse oder Gruppe" />
          </Field>
          <Field label="Rolle">
            <Select options={roles} value="Bearbeiten" />
          </Field>
        </Field.Row>
        <List label="Personen und Gruppen">
          <Row avatar={{ name: "Mira Solberg" }} lines={["Mira Solberg"]} meta="mira.solberg@example.org" end={<Text type="row">Besitzerin</Text>} />
          <Row avatar={{ name: "Felix Thal" }} lines={["Felix Thal"]} meta="felix.thal@example.org" end={role("Felix Thal", "Verwalten")} />
          <Row
            mark={{ icon: "users-group", color: "#7c3aed" }}
            lines={["Werkstatt"]}
            meta="Gruppe · 6 Personen"
            end={
              <>
                <Avatar.Stack
                  people={[
                    { name: "Jonas Kern" },
                    { name: "Sami Yilmaz" },
                    { name: "Paula Brandt" },
                    { name: "Felix Thal" },
                    { name: "Ada Renz" },
                    { name: "Tom Ochs" },
                  ]}
                />
                {role("Werkstatt", "Bearbeiten")}
              </>
            }
          />
          <Row
            avatar={{ name: "Jonas Kern" }}
            lines={["Jonas Kern"]}
            meta="jonas.kern@example.org · auch über Werkstatt"
            end={role("Jonas Kern", "Bearbeiten")}
          />
          <Row mark={{ icon: "users-group", color: "#0891b2" }} lines={["Büro"]} meta="Gruppe · 3 Personen" end={role("Büro", "Ansehen")} />
          <Row avatar={{ name: "Sami Yilmaz" }} lines={["Sami Yilmaz"]} meta="sami.yilmaz@example.org" end={role("Sami Yilmaz", "Ansehen")} />
          <Row
            icon="mail"
            lines={["lena.hartwig@example.org"]}
            meta="Eingeladen vor 2 Tagen"
            action={{ label: "Erneut senden" }}
            end={role("lena.hartwig@example.org", "Bearbeiten")}
          />
        </List>
      </Section>
      <Section form title="Zugriff per Link" summary="Wer die Base über ihren Link öffnen kann.">
        <Choice
          name="link"
          label="Zugriff per Link"
          value="invited"
          options={[
            { value: "invited", label: "Nur Eingeladene" },
            { value: "org", label: "Alle in der Organisation" },
            { value: "public", label: "Jeder mit dem Link" },
          ]}
        />
        <Field label="Link">
          <Input value="cloud.example.org/grids/b/werkstatt" end={<Button variant="ghost" icon="copy" label="Link kopieren" />} />
        </Field>
      </Section>
      <Section form title="Vererbung" summary="Tabellen und Formulare übernehmen diesen Zugriff. Eigene Regeln gelten zusätzlich.">
        <List label="Eigene Regeln">
          <Row
            mark={{ icon: "table", color: grids }}
            lines={["Lohnstunden"]}
            meta="eingeschränkt sichtbar · nur wer verwaltet · 2 Personen"
            action={{ label: "Ändern" }}
          />
          <Row
            mark={{ icon: "forms", color: "#db2777" }}
            lines={["Auftrag annehmen"]}
            meta="öffentliches Formular · jeder mit dem Link kann ausfüllen"
            action={{ label: "Ändern" }}
          />
        </List>
      </Section>
    </Pane>
  </Workspace>
);

/** Standorte › Standorteinstellungen › Zeiten und Schichten (study screen b). */
export const VenueTimesScreen = () => (
  <Workspace
    sidebarLabel="Breite der Seitenleiste"
    sidebar={
      <Nav
        title="Standorte"
        icon="building-store"
        groups={[
          {
            items: [
              { label: "Übersicht", icon: "layout-grid" },
              { label: "Schichtplan", icon: "calendar-week" },
              { label: "Team", icon: "users", count: 14 },
            ],
          },
          {
            label: "Campus-Café Nord",
            items: [
              { label: "Zeiten und Schichten", icon: "clock", current: true },
              { label: "Räume", icon: "door" },
              { label: "Kasse", icon: "cash-register" },
            ],
          },
        ]}
      />
    }
    head={<Bar start={<RecordHead name="Campus-Café Nord" kinds={["Standort"]} />} />}
  >
    <Pane
      label="Zeiten und Schichten"
      head={
        <Tabs
          label="Einstellungen des Standorts"
          items={[{ label: "Allgemein" }, { label: "Zeiten und Schichten", current: true }, { label: "Kasse" }, { label: "Team" }]}
        />
      }
    >
      <Section
        form
        title="Öffnungszeiten"
        summary="Wann Gäste kommen können. Gilt für die Website und den Aushang."
        actions={[{ label: "Zeiten ändern", icon: "pencil" }]}
      >
        <List label="Öffnungszeiten">
          <Row icon="sun" lines={["Montag bis Freitag"]} meta="08:00–18:00" />
          <Row icon="sun" lines={["Samstag"]} meta="10:00–16:00" />
          <Row icon="moon" lines={["Sonntag"]} meta="geschlossen" />
        </List>
      </Section>
      <Section
        form
        title="Abweichungen"
        count={3}
        summary="Feiertage, Betriebsferien und Veranstaltungen."
        actions={[{ label: "Abweichung", icon: "plus" }]}
      >
        <List label="Abweichungen">
          <Row icon="calendar-off" lines={["Do., 24.12."]} meta="Heiligabend · Geschlossen" />
          <Row icon="calendar-minus" lines={["Do., 31.12."]} meta="Silvester · Verkürzt bis 14:00" />
          <Row icon="calendar-plus" lines={["Sa., 09.01."]} meta="Semesterfest · Länger offen bis 23:00" />
        </List>
      </Section>
      <Section form title="Schichten" count={4} summary="Wer wann da ist. Besetzung der letzten 4 Wochen." actions={[{ label: "Schicht", icon: "plus" }]}>
        <List label="Schichten">
          <Row icon="clock" lines={["Früh"]} meta="06:30–12:30 · 2 Personen" end={<Text type="meta">28 von 28 besetzt</Text>} />
          <Row icon="clock" lines={["Mittag"]} meta="11:00–15:00 · 3 Personen" end={<Text type="meta">27 von 28 besetzt</Text>} />
          <Row icon="clock" lines={["Spät"]} meta="14:30–18:30 · 2 Personen" end={<Text type="meta">21 von 28 besetzt</Text>} />
          <Row icon="clock" lines={["Samstag"]} meta="09:30–16:30 · 2 Personen" end={<Text type="meta">4 von 4 besetzt</Text>} />
        </List>
      </Section>
    </Pane>
  </Workspace>
);
