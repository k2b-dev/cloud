import { render } from "solid-js/web";
import { Chip, Choice, Empty, Pane, Section, Table, Workspace } from "../src/v2";

// Parts that changed their default look: a choice whose options say what they mean (cards), states in a table (dot and
// word), and an empty place (in the middle, its sentence a title).

declare global {
  interface Window {
    __k2Mounted?: boolean;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("taste parts: #root is missing");
render(
  () => (
    <Workspace>
      <Pane label="Teile">
        <Section title="Zugriff per Link">
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
          <Choice name="plain" label="Übergabe" value="Abholung" options={["Abholung", "Lieferung"]} />
          <Choice
            name="locked"
            label="Gesperrt"
            value="a"
            disabled
            options={[
              { value: "a", label: "Nur Eingeladene", hint: "Personen und Gruppen oben" },
              { value: "b", label: "Alle", hint: "Nach Anmeldung" },
            ]}
          />
        </Section>
        <Section title="Aufträge">
          <Table
            label="Aufträge"
            rows={[
              { name: "A-0412", state: "ok" as const, word: "Fertig" },
              { name: "A-0418", state: "warn" as const, word: "Wartet auf Teile" },
              { name: "A-0421", state: "bad" as const, word: "Überfällig" },
            ]}
            columns={[
              { title: "Nr.", cell: (row) => row.name },
              { title: "Status", cell: (row) => <Chip status={row.state}>{row.word}</Chip> },
            ]}
          />
        </Section>
        <Empty
          icon="clipboard-list"
          text="Noch keine Aufträge"
          hint="Aufträge kommen über das Formular."
          action={{ label: "Formular öffnen" }}
        />
      </Pane>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
