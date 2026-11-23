// Recipe: a form with a required field, a range limit, an error from the server at its field, and a conflict that
// blocks saving. The form state lives in the app; the primitives only show it. (Dialog comes with the behaviour layer;
// until then a form stands in its own pane.)
import { Band, Bar, Button, Check, Choice, Field, Input, Notice, Pane, Select, Text, Workspace } from "@k2b/ui/v2";

type Errors = Partial<Record<"name" | "interval" | "url", string>>;

// What the server answered on the last save: one error at its field, one conflict for the whole form.
const errors: Errors = { url: "Diese Adresse antwortet nicht (HTTP 404).", interval: "Mindestens 60 Sekunden." };
const conflict = true;

export default function SourceForm() {
  return (
    <Workspace head={<Bar start={<Text type="body">Neue Quelle</Text>} />}>
      <Pane label="Neue Quelle">
        {conflict && (
          <Notice tone="warn" title="Inzwischen geändert" actions={[{ label: "Neu laden", icon: "refresh" }]}>
            Ada Renz hat diese Quelle um 09:41 geändert. Lade neu, bevor du speicherst.
          </Notice>
        )}
        <Band>
          <Field name="name" label="Name" hint="So erscheint die Quelle in der Liste." error={errors.name}>
            <Input value="Lackfabrik Nordhaus" />
          </Field>
          <Field.Row>
            <Field name="kind" label="Art">
              <Select options={["Webhook", "Abruf"]} value="Abruf" />
            </Field>
            <Field name="interval" label="Intervall" optional="Sekunden" error={errors.interval}>
              <Input type="number" value="30" min={60} max={86400} />
            </Field>
          </Field.Row>
          <Field name="url" label="Adresse" error={errors.url}>
            <Input type="url" value="https://nordhaus.example/hook" />
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
              <Button variant="primary" type="submit" disabled={conflict}>
                Speichern
              </Button>
            </>
          }
        />
      </Pane>
    </Workspace>
  );
}
