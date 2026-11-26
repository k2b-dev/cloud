import { createSignal, For, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { Band, Bar, Button, Field, Input, Notice, Pane, Section, Table, Text, Workspace } from "../src/v2";

// A long form of settings, as an admin page draws it: many fields in sections, and a foot with "Verwerfen" and
// "Speichern". The first change makes the foot stay on the bottom of the column. "Speichern" is the page's one primary,
// so the page has no floating main action. The test picks the layout before the script runs: the form alone or beside
// an info column (`Pane.Split`), and what ends the column before the foot (a section, a notice, a band, a table).

declare global {
  interface Window {
    __k2Mounted?: boolean;
    __k2Layout?: "pane" | "split";
    __k2Last?: "section" | "notice" | "band" | "table";
  }
}

const sections = [
  { title: "Allgemein", fields: ["Name der Installation", "Adresse", "Kontakt für Rückfragen", "Zeitzone"] },
  { title: "Anmeldung", fields: ["Sitzungsdauer", "Zweiter Faktor", "Erlaubte Domains", "Sperre nach Fehlversuchen"] },
  { title: "E-Mail", fields: ["Absender", "Antwortadresse", "SMTP-Server", "SMTP-Port", "Benutzer"] },
  { title: "Speicher", fields: ["Kontingent je Person", "Papierkorb leeren nach", "Größte Datei", "Vorschau bis"] },
] as const;
const keys = [
  { name: "Backup", created: "12.11.2026" },
  { name: "Monitoring", created: "03.10.2026" },
];

const root = document.getElementById("root");
if (!root) throw new Error("pane-foot: #root is missing");
const [unsaved, setUnsaved] = createSignal(false);
const last = (): JSX.Element => {
  switch (window.__k2Last) {
    case "notice":
      return <Notice tone="note">Änderungen gelten ab der nächsten Anmeldung.</Notice>;
    case "band":
      return (
        <Band>
          <Text>Zuletzt geändert am 12.11.2026 von Ada Renz.</Text>
        </Band>
      );
    case "table":
      return (
        <Table
          label="Schlüssel"
          rows={keys}
          phone={(row) => ({ lines: [row.name, `angelegt ${row.created}`] })}
          columns={[
            { title: "Name", width: { min: 160, default: 220 }, cell: (row) => row.name },
            { title: "Angelegt", width: { min: 100, default: 120 }, cell: (row) => row.created },
          ]}
        />
      );
    default:
      return null;
  }
};
const form = () => (
  <Pane
    label="Einstellungen"
    unsaved={unsaved()}
    foot={
      <Bar
        end={
          <>
            <Button onClick={() => setUnsaved(false)}>Verwerfen</Button>
            <Button variant="primary" onClick={() => setUnsaved(false)}>
              Speichern
            </Button>
          </>
        }
      />
    }
  >
    <For each={sections}>
      {(section) => (
        <Section title={section.title}>
          <For each={section.fields}>
            {(label) => (
              <Field name={label} label={label}>
                <Input value="" onInput={() => setUnsaved(true)} />
              </Field>
            )}
          </For>
        </Section>
      )}
    </For>
    {last()}
  </Pane>
);
render(
  () => (
    <Workspace head={<Bar start={<Text type="lead">Einstellungen</Text>} />}>
      {window.__k2Layout === "split" ? (
        <Pane.Split>
          {form()}
          <Pane label="Info" width={{ min: 240, default: 280 }} side>
            <Section title="Installation">
              <Text>Version 0.80, seit 12.11.2026 in Betrieb.</Text>
            </Section>
          </Pane>
        </Pane.Split>
      ) : (
        form()
      )}
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
