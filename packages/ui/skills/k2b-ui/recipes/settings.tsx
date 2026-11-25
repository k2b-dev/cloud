// Recipe: a settings page with the controls beyond text: a field that goes back to its default, a choice the person
// may not change, a list of values as tags, an image, a colour, a number on a range, a code from another device, and
// questions that open in place.
// The values live in the app; the primitives only show them.
import {
  Band,
  Bar,
  Button,
  CodeInput,
  ColorInput,
  Disclosure,
  Field,
  ImageInput,
  Pane,
  Section,
  Select,
  Slider,
  TagsInput,
  Text,
  Workspace,
} from "@k2b/ui/v2";

// A small logo as a data URL, so the recipe draws without the network.
const logo =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'><rect width='48' height='48' fill='%230f766e'/><path d='M14 34V14h6l8 12V14h6v20h-6l-8-12v12z' fill='white'/></svg>";

type Props = { locked?: boolean; empty?: boolean };

export default function SignInSettings(props: Props) {
  return (
    <Workspace head={<Bar start={<Text type="body">Anmeldung</Text>} />}>
      <Pane label="Anmeldung">
        <Band>
          <Field
            name="session"
            label="Sitzungsdauer"
            hint="Danach melden sich Personen neu an."
            action={{ label: "Auf Standard zurücksetzen", icon: "restore" }}
          >
            <Select options={["8 Stunden", "24 Stunden", "7 Tage"]} value="7 Tage" disabled={props.locked} />
          </Field>
          <Field name="method" label="Verfahren" hint="Legt der Betreiber fest.">
            <Select options={["Passwort und Passkey", "Nur Passkey"]} value="Passwort und Passkey" disabled />
          </Field>
          <Field name="domains" label="Erlaubte Domains" hint="Enter fügt eine Domain an.">
            <TagsInput
              value={props.empty ? [] : ["werkstatt.example", "k2b.example"]}
              placeholder="z. B. firma.example"
              disabled={props.locked}
            />
          </Field>
          <Field name="logo" label="Logo auf der Anmeldeseite" optional="optional">
            <ImageInput value={props.empty ? null : logo} onChange={() => undefined} disabled={props.locked} />
          </Field>
        </Band>
        <Section title="Anmeldeseite">
          <Field name="accent" label="Akzentfarbe">
            <ColorInput value="#0f766e" swatches={["#0f766e", "#1d4ed8", "#b45309", "#8e1b6f"]} disabled={props.locked} />
          </Field>
          <Field name="dim" label="Hintergrund abdunkeln">
            <Slider value={0.3} min={0} max={0.8} step={0.05} format={{ style: "percent" }} disabled={props.locked} />
          </Field>
        </Section>
        <Section title="Gerät koppeln">
          <Field name="code" label="Code vom anderen Gerät" hint="Sechs Ziffern, sie gelten fünf Minuten.">
            <CodeInput autocomplete="off" disabled={props.locked} />
          </Field>
        </Section>
        <Section title="Fragen">
          <Disclosure title="Was passiert mit laufenden Sitzungen?">
            <Text type="body">Sie gelten bis zu ihrem Ende weiter. Eine kürzere Dauer greift bei der nächsten Anmeldung.</Text>
          </Disclosure>
          <Disclosure title="Wer darf diese Einstellungen ändern?">
            <Text type="body">Personen mit der Rolle „Verwaltung“. Das Verfahren legt nur der Betreiber fest.</Text>
          </Disclosure>
        </Section>
        <Bar
          end={
            <>
              <Button href="#">Abbrechen</Button>
              <Button variant="primary" type="submit" disabled={props.locked}>
                Speichern
              </Button>
            </>
          }
        />
      </Pane>
    </Workspace>
  );
}

// The states that Fibel's Example offers beside the default; the recipe test renders each one as well.
export const states = {
  // nothing set yet: no tags, no logo
  empty: () => <SignInSettings empty />,
  // while a save runs, or for a person who may only read: every control takes no input
  locked: () => <SignInSettings locked />,
};
