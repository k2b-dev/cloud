import { render } from "solid-js/web";
import { Check, Field, Input, Pane, Row, Section, Workspace } from "../src/v2";

// Texts of free length in v2 primitives, as an FAQ draws them: a section whose title is a long question, a short one
// for comparison, a check with a line that says what it does, and a multi-line field that grows with its words.

declare global {
  interface Window {
    __k2Mounted?: boolean;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("text-shapes: #root is missing");
render(
  () => (
    <Workspace>
      <Pane label="Fragen">
        <Section icon="help" title="Kurz" count={2}>
          <Row lines={["Eine Antwort"]} />
        </Section>
        <Section
          icon="help"
          title="Wie lange dauert es, bis eine Einlieferung nach der Auktion ausgezahlt wird, und wer bekommt dazu eine Nachricht?"
          count={3}
          actions={[{ label: "Bearbeiten", icon: "pencil" }]}
        >
          <Row lines={["Nach der Abrechnung, meist zwei Wochen nach der Auktion."]} />
        </Section>
        <Section title="Einstellungen">
          <Check name="public" label="Öffentlich zeigen" description="Wer die Seite kennt, sieht diese Frage ohne Anmeldung." />
          <Field name="answer" label="Antwort">
            <Input multiline value="Eine Zeile" />
          </Field>
          <Field name="note" label="Notiz">
            <Input multiline rows={5} />
          </Field>
        </Section>
      </Pane>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
