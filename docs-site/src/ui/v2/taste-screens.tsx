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

// The access settings of a base, after the taste study (v2-taste-study v2, screen a), built only from @k2b/ui/v2 primitives:
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
          { label: "Aufträge", icon: "table", color: grids, count: 128 },
          { label: "Auftrag annehmen", icon: "forms", color: "#db2777" },
          { label: "Kunden", icon: "table", color: grids, count: 342 },
        ],
      },
      {
        label: "Lager",
        items: [
          { label: "Ersatzteile", icon: "table", color: grids, count: 642 },
          { label: "Lieferanten", icon: "table", color: grids, count: 38 },
        ],
      },
      {
        label: "Auswertung",
        items: [
          { label: "Offene Aufträge", icon: "filter", color: "#7c3aed", count: 17 },
          { label: "Diese Woche", icon: "calendar", color: "#7c3aed", count: 9 },
          { label: "Rechnung", icon: "file-invoice", color: "#7c3aed" },
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
      <Section title="Personen und Gruppen" count={12} summary="Wer diese Base öffnen, bearbeiten oder verwalten darf.">
        <Field.Row action={{ label: "Einladen", primary: true }}>
          <Field label="Einladen">
            <Input placeholder="Name, E-Mail-Adresse oder Gruppe" />
          </Field>
          <Field label="Rolle">
            <Select options={roles} value="Bearbeiten" />
          </Field>
        </Field.Row>
        <List label="Personen und Gruppen">
          <Row
            avatar={{ name: "Mira Solberg" }}
            lines={["Mira Solberg"]}
            meta="mira.solberg@example.org"
            end={<Text type="row">Besitzerin</Text>}
          />
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
          <Row
            avatar={{ name: "Sami Yilmaz" }}
            lines={["Sami Yilmaz"]}
            meta="sami.yilmaz@example.org"
            end={role("Sami Yilmaz", "Ansehen")}
          />
          <Row
            icon="mail"
            lines={["lena.hartwig@example.org"]}
            meta="Eingeladen vor 2 Tagen"
            action={{ label: "Erneut senden" }}
            end={role("lena.hartwig@example.org", "Bearbeiten")}
          />
        </List>
      </Section>
      <Section title="Zugriff per Link" summary="Wer die Base über ihren Link öffnen kann.">
        <Choice
          name="link"
          label="Zugriff per Link"
          value="invited"
          options={[
            { value: "invited", label: "Nur Eingeladene", hint: "Personen und Gruppen oben", icon: "lock" },
            { value: "org", label: "Alle in der Organisation", hint: "Nach Anmeldung, nur ansehen", icon: "building" },
            { value: "public", label: "Jeder mit dem Link", hint: "Ohne Anmeldung, nur ansehen", icon: "world" },
          ]}
        />
        <Field label="Link">
          <Input value="cloud.example.org/grids/b/werkstatt" end={<Button variant="ghost" icon="copy" label="Link kopieren" />} />
        </Field>
      </Section>
      <Section title="Vererbung" summary="Tabellen und Formulare übernehmen diesen Zugriff. Eigene Regeln gelten zusätzlich.">
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
