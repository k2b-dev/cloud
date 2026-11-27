// Recipe: a form with a required field, a range limit, an error from the server at its field, and a conflict that
// blocks saving. The form state lives in the app; the primitives only show it. This form has a page of its own; a
// form over the page is a `Dialog`.
import { Band, Bar, Button, Check, Choice, Field, Input, Notice, Pane, Select, Text, Workspace } from "@k2b/ui/v2";

type Values = { name: string; kind: string; interval: string; url: string };
type Errors = Partial<Record<keyof Values, string>>;

const source: Values = { name: "Lackfabrik Nordhaus", kind: "Abruf", interval: "30", url: "https://nordhaus.example/hook" };
// What the server answered on the last save: one error at its field, one conflict for the whole form.
const answer: Errors = { url: "Diese Adresse antwortet nicht (HTTP 404).", interval: "Mindestens 60 Sekunden." };

type Props = { values?: Values; errors?: Errors; conflict?: boolean; saving?: boolean };

export default function SourceForm(props: Props) {
  const values = props.values ?? source;
  const errors = props.errors ?? answer;
  const conflict = props.conflict ?? true;
  return (
    <Workspace head={<Bar start={<Text type="body">Neue Quelle</Text>} />}>
      <Pane label="Neue Quelle">
        {conflict && (
          <Notice tone="warn" title="Inzwischen geändert" actions={[{ label: "Neu laden", icon: "refresh" }]}>
            Ada Renz hat diese Quelle um 09:41 geändert. Lade neu, bevor du speicherst.
          </Notice>
        )}
        <Band>
          <Field name="name" label="Name" required hint="So erscheint die Quelle in der Liste." error={errors.name}>
            <Input value={values.name} />
          </Field>
          <Field.Row>
            <Field name="kind" label="Art">
              <Select options={["Webhook", "Abruf"]} value={values.kind} />
            </Field>
            <Field name="interval" label="Intervall" optional="Sekunden" error={errors.interval}>
              <Input type="number" value={values.interval} min={60} max={86400} />
            </Field>
          </Field.Row>
          <Field name="url" label="Adresse" required error={errors.url}>
            <Input type="url" value={values.url} />
          </Field>
        </Band>
        <Band>
          <Choice name="notify" label="Benachrichtigen" options={["Bei jedem Fehler", "Einmal am Tag"]} value="Bei jedem Fehler" />
          <Check name="active" switch label="Sofort aktiv" checked />
        </Band>
        <Bar
          end={
            <>
              <Button href="#">Abbrechen</Button>
              {/* the one primary of the page: dimmed while the conflict lasts, turning while the save runs */}
              <Button variant="primary" type="submit" disabled={conflict} busy={props.saving}>
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
  // a new source: nothing sent yet, so no field shows an error
  fresh: () => <SourceForm values={{ name: "", kind: "Webhook", interval: "", url: "" }} errors={{}} conflict={false} />,
  // the save came back with errors at their fields; nothing blocks the next save
  errors: () => <SourceForm values={{ ...source, name: "" }} errors={{ ...answer, name: "Pflichtfeld." }} conflict={false} />,
  saving: () => <SourceForm errors={{}} conflict={false} saving />,
};
