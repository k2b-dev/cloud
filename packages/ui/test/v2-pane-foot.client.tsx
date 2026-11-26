import { createSignal, For } from "solid-js";
import { render } from "solid-js/web";
import { Bar, Button, Field, Input, Pane, Section, Text, Workspace } from "../src/v2";

// A long form of settings, as an admin page draws it: many fields in sections, and a foot with "Verwerfen" and
// "Speichern". The first change makes the foot stay on the bottom of the column. "Speichern" is the page's one primary,
// so the page has no floating main action.

declare global {
  interface Window {
    __k2Mounted?: boolean;
  }
}

const sections = [
  { title: "Allgemein", fields: ["Name der Installation", "Adresse", "Kontakt für Rückfragen", "Zeitzone"] },
  { title: "Anmeldung", fields: ["Sitzungsdauer", "Zweiter Faktor", "Erlaubte Domains", "Sperre nach Fehlversuchen"] },
  { title: "E-Mail", fields: ["Absender", "Antwortadresse", "SMTP-Server", "SMTP-Port", "Benutzer"] },
  { title: "Speicher", fields: ["Kontingent je Person", "Papierkorb leeren nach", "Größte Datei", "Vorschau bis"] },
] as const;

const root = document.getElementById("root");
if (!root) throw new Error("pane-foot: #root is missing");
const [unsaved, setUnsaved] = createSignal(false);
render(
  () => (
    <Workspace head={<Bar start={<Text type="lead">Einstellungen</Text>} />}>
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
      </Pane>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
