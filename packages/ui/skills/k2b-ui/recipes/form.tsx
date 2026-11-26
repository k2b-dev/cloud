// Recipe: a form with a required field, a range limit, an error from the server at its field, and a conflict that
// blocks saving. The form state lives in the app; the primitives only show it. This form has a page of its own; a
// form over the page is a `Dialog`.
import {
  Bar,
  Button,
  Check,
  Chip,
  Choice,
  Digest,
  Empty,
  Field,
  Inline,
  Input,
  List,
  Mark,
  Nav,
  Notice,
  Pane,
  Path,
  Row,
  Section,
  Select,
  Text,
  Workspace,
} from "@k2b/ui/v2";

// The app this screen belongs to: its colour tints the page and marks it in the host's rail.
export const app = { color: "#0e7490", icon: "activity" };

// One mark per kind of source, the same in the sidebar, the list and this form.
const kind = {
  webhook: { icon: "webhook", color: "#0e7490" },
  poll: { icon: "refresh", color: "#2563eb" },
  mail: { icon: "mail", color: "#7c3aed" },
  file: { icon: "server", color: "#c2410c" },
};

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
    <Workspace
      primary={{ label: "Speichern", icon: "check", disabled: conflict || props.saving }}
      sidebar={
        <Nav
          title="Pulse"
          icon="activity"
          groups={[
            {
              items: [
                { label: "Quellen", icon: "plug", current: true, count: 11, dot: "bad" },
                { label: "Ereignisse", icon: "list", href: "#ereignisse" },
                { label: "Regeln", icon: "route", count: 14, href: "#regeln" },
              ],
            },
            {
              label: "Arten",
              items: [
                { label: "Webhooks", ...kind.webhook, href: "#webhooks" },
                { label: "Abrufe", ...kind.poll, href: "#abrufe" },
                { label: "Postfächer", ...kind.mail, href: "#postfaecher" },
                { label: "SFTP", ...kind.file, href: "#sftp" },
              ],
            },
          ]}
        />
      }
      head={
        <Bar
          start={
            <Inline>
              <Mark {...(values.kind === "Webhook" ? kind.webhook : kind.poll)} />
              <Path label="Ort" items={[{ label: "Quellen", href: "#quellen" }, { label: values.name || "Neue Quelle" }]} />
            </Inline>
          }
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
      }
    >
      <Pane label="Neue Quelle">
        {conflict && (
          <Notice tone="warn" title="Inzwischen geändert" actions={[{ label: "Neu laden", icon: "refresh" }]}>
            Ada Renz hat diese Quelle um 09:41 geändert. Lade neu, bevor du speicherst.
          </Notice>
        )}
        <Pane.Split>
          <Pane label="Angaben">
            <Section icon="plug" title="Verbindung">
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
            </Section>
            <Section icon="bell" title="Meldungen">
              <Choice name="notify" label="Benachrichtigen" options={["Bei jedem Fehler", "Einmal am Tag"]} value="Bei jedem Fehler" />
              <Check name="active" switch label="Sofort aktiv" checked />
            </Section>
          </Pane>
          {/* the side column only while it is full: what the source feeds, and who changed it */}
          <Pane side label="Was sie liefert" width={{ min: 280, default: 340 }}>
            <Section icon="route" title="Regeln" count={values.name ? 3 : undefined}>
              {values.name ? (
                <List label="Regeln mit dieser Quelle">
                  <Row
                    mark={{ icon: "package", color: "#0e7490" }}
                    lines={["Lieferung in Bestand buchen", "Lager Nord · 214 Mal diese Woche"]}
                  />
                  <Row mark={{ icon: "receipt", color: "#8e1b6f" }} lines={["Rechnung an Finanzen", "Finanzen · 12 Mal diese Woche"]} />
                  <Row
                    mark={{ icon: "bell", color: "#c2410c" }}
                    lines={["Farbe knapp melden", "Werkstatt · zuletzt Mo."]}
                    marks={<Chip status="warn">Pausiert</Chip>}
                  />
                </List>
              ) : (
                <Empty icon="route" text="Nach dem Speichern kann eine Regel diese Quelle nutzen." />
              )}
            </Section>
            <Section icon="history" title="Geändert">
              {values.name ? (
                <Digest
                  label="Geändert"
                  activity={[
                    {
                      person: { name: "Ada Renz" },
                      text: (
                        <>
                          <Text weight="strong">Ada Renz</Text> hat die Adresse geändert
                        </>
                      ),
                      time: "heute, 09:41",
                    },
                    {
                      person: { name: "Felix Thal" },
                      text: (
                        <>
                          <Text weight="strong">Felix Thal</Text> hat die Quelle angelegt
                        </>
                      ),
                      time: "3. Nov.",
                    },
                  ]}
                />
              ) : (
                <Empty icon="history" text="Noch nicht gespeichert." />
              )}
            </Section>
          </Pane>
        </Pane.Split>
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
