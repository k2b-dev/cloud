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
  Table,
  Text,
  Workspace,
} from "@k2b/ui/v2";

// The app this screen belongs to: its colour tints the page and marks it in the host's rail.
export const app = { name: "Pulse", color: "#0e7490", icon: "activity" };

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
// The fields of the last delivery, each with the mark of its kind, and where the source puts them.
const fieldKind = {
  text: { icon: "letter-case", color: "#475569" },
  number: { icon: "number", color: "#0e7490" },
  date: { icon: "calendar", color: "#7c3aed" },
  amount: { icon: "currency-euro", color: "#15803d" },
};
const fields: { name: string; kind: keyof typeof fieldKind; sample: string; target: string }[] = [
  { name: "artikel", kind: "text", sample: "Klarlack seidenmatt 5 l", target: "Bestand · Artikel" },
  { name: "menge", kind: "number", sample: "6", target: "Bestand · Menge" },
  { name: "charge", kind: "text", sample: "CH-2611-0442", target: "Bestand · Charge" },
  { name: "lieferdatum", kind: "date", sample: "26.11.2026", target: "Wareneingang · Tag" },
  { name: "preis", kind: "amount", sample: "214,00 €", target: "Finanzen · Beleg" },
  { name: "lieferschein", kind: "text", sample: "LS-88213", target: "Wareneingang · Nummer" },
];

// What the server answered on the last save: one error at its field, one conflict for the whole form.
const answer: Errors = { url: "Diese Adresse antwortet nicht (HTTP 404).", interval: "Mindestens 60 Sekunden." };

type Props = { values?: Values; errors?: Errors; conflict?: boolean; saving?: boolean };

export default function SourceForm(props: Props) {
  const values = props.values ?? source;
  const errors = props.errors ?? answer;
  const conflict = props.conflict ?? true;
  return (
    <Workspace
      // the form's footer holds its one primary, on the phone too; a floating "Speichern" would say it twice
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
            {/* what the last delivery carried and where each field goes: the form's work in context */}
            <Section
              icon="arrows-exchange"
              title="Felder aus der Quelle"
              count={fields.length}
              more={{ label: "Zuordnung ändern", forward: true }}
            >
              <Table
                label="Felder aus der Quelle"
                rows={fields}
                phone={(field) => ({ mark: fieldKind[field.kind], lines: [field.name, `${field.sample} → ${field.target}`] })}
                columns={[
                  { title: "Feld", width: { min: 140, default: 200 }, mark: (field) => fieldKind[field.kind], cell: (field) => field.name },
                  { title: "Zuletzt", width: { min: 120, default: 220 }, drop: true, cell: (field) => field.sample },
                  { title: "Geht nach", cell: (field) => field.target },
                ]}
              />
            </Section>
            {/* the form ends with its deeds: cancel, then the page's one primary, dimmed while the conflict lasts and
                turning while the save runs */}
            <Bar
              end={
                <>
                  <Button href="#">Abbrechen</Button>
                  <Button variant="primary" type="submit" disabled={conflict} busy={props.saving}>
                    Speichern
                  </Button>
                </>
              }
            />
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
            <Section icon="activity" title="Letzte Abrufe" count={values.name ? 4 : undefined}>
              {values.name ? (
                <List label="Letzte Abrufe">
                  <Row
                    mark={{ icon: "clock-x", color: "#dc2626" }}
                    lines={["Keine Antwort", "HTTP 404 · nach 1,2 s"]}
                    time="09:44"
                    marks={<Chip status="bad">Fehler</Chip>}
                  />
                  <Row
                    mark={{ icon: "clock-x", color: "#dc2626" }}
                    lines={["Keine Antwort", "HTTP 404 · nach 1,1 s"]}
                    time="09:43"
                    marks={<Chip status="bad">Fehler</Chip>}
                  />
                  <Row mark={{ icon: "package", color: "#0e7490" }} lines={["6 Gebinde geliefert", "Lieferschein LS-88213"]} time="09:12" />
                  <Row
                    mark={{ icon: "package", color: "#0e7490" }}
                    lines={["2 Gebinde geliefert", "Lieferschein LS-88207"]}
                    time="gestern"
                  />
                </List>
              ) : (
                <Empty icon="activity" text="Nach dem Speichern steht hier jeder Abruf." />
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
