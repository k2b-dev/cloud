import { createSignal, For } from "solid-js";
import { render } from "solid-js/web";
import { Check, Field, Input, Pane, Row, Section, Workspace } from "../src/v2";

// Texts of free length in v2 primitives, as an FAQ draws them: a section whose title is a long question, a short one
// for comparison, a check with a line that says what it does, and a multi-line field that grows with its words.

declare global {
  interface Window {
    __k2Mounted?: boolean;
    /** Sets the long explanation at the end of the pane from code, as an app that loads or resets it. */
    __k2SetAnswer?: (text: string) => void;
  }
}

// a controlled explanation of nine lines at the end of a pane that scrolls
const [answer, setAnswer] = createSignal(Array.from({ length: 9 }, (_, line) => `Zeile ${line + 1} der Erklärung`).join("\n"));
window.__k2SetAnswer = setAnswer;

const root = document.getElementById("root");
if (!root) throw new Error("text-shapes: #root is missing");
render(
  () => (
    <Workspace>
      <Pane label="Fragen">
        <Section title="Kurz" count={2}>
          <Row lines={["Eine Antwort"]} />
        </Section>
        <Section
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
        <Section title="Ältere Fragen" count={12}>
          <For each={Array.from({ length: 12 }, (_, index) => index + 1)}>{(index) => <Row lines={[`Frage ${index}`]} />}</For>
        </Section>
        <Section title="Erklärung">
          <Field name="explain" label="Ausführliche Erklärung">
            <Input multiline value={answer()} onInput={setAnswer} />
          </Field>
        </Section>
      </Pane>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
