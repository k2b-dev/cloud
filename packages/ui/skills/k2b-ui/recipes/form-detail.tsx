// Recipe: a form beside a list. The page's one primary ("Neuer Termin") stays in the head and opened the form; the
// form saves with a default button in its own footer bar. On the phone the form is the page, with one way back.
import {
  Band,
  Bar,
  Button,
  Check,
  Chip,
  Choice,
  DateInput,
  Field,
  Input,
  List,
  Nav,
  Pane,
  Row,
  Select,
  StatusRow,
  Tabs,
  Text,
  Workspace,
} from "@k2b/ui/v2";

// The app this screen belongs to: its colour tints the page and marks it in the host's rail.
export const app = { color: "#c2410c", icon: "tool" };

// One mark per kind of appointment, the same in the calendar, the list and every sentence.
const kind = {
  pickup: { icon: "truck-loading", color: "#0e7490" },
  check: { icon: "clipboard-check", color: "#15803d" },
  fit: { icon: "hammer", color: "#c2410c" },
  measure: { icon: "ruler-measure", color: "#7c3aed" },
};

type Appointment = { id: string; customer: string; work: string; kind: keyof typeof kind; fitter: string; day: string; clash?: boolean };

const appointments: Appointment[] = [
  { id: "t1", customer: "Tischlerei Aaltonen", work: "Kreissäge abholen", kind: "pickup", fitter: "Jonas", day: "heute, 14:00" },
  { id: "t2", customer: "Praxis Dr. Lindqvist", work: "Aufmaß Küche", kind: "measure", fitter: "Mira", day: "heute, 16:30", clash: true },
  { id: "t3", customer: "Familie Oswald", work: "Bad, Waschtisch montieren", kind: "fit", fitter: "Sami", day: "Fr. 27. Nov." },
  { id: "t4", customer: "Praxis Dr. Lindner", work: "Notstrom prüfen", kind: "check", fitter: "Jonas", day: "Mo. 30. Nov." },
  { id: "t5", customer: "Hotel Seeblick", work: "Empfangstresen aufmessen", kind: "measure", fitter: "Mira", day: "Di. 1. Dez." },
  { id: "t6", customer: "Stadtwerke Auental", work: "Pumpe P3 einbauen", kind: "fit", fitter: "Sami", day: "Do. 3. Dez." },
  { id: "t7", customer: "Weingut Hartwig", work: "Kelterpresse prüfen", kind: "check", fitter: "Jonas", day: "Fr. 4. Dez." },
  { id: "t8", customer: "Gemeinde Ohlsbach", work: "Aufsitzmäher abholen", kind: "pickup", fitter: "Wer frei ist", day: "Fr. 4. Dez." },
];
const customers = ["Familie Oswald", "Praxis Dr. Lindner", "Stadtwerke Auental", "Tischlerei Aaltonen"];

type Values = { customer: string; day: string; time: string; length: string; fitter: string; note: string };
type Errors = Partial<Record<keyof Values, string>>;

const draft: Values = {
  customer: "Familie Oswald",
  day: "27.11.2026",
  time: "09:30",
  length: "2 Stunden",
  fitter: "Jonas Wehrle",
  note: "",
};

type Props = { values?: Values; errors?: Errors; saving?: boolean };

export default function NewAppointment(props: Props) {
  const values = props.values ?? draft;
  const errors = props.errors ?? {};
  return (
    <Workspace
      detail
      sidebar={
        <Nav
          title="Werkstatt"
          icon="tool"
          groups={[
            {
              items: [
                { label: "Heute", icon: "sun", href: "#heute" },
                { label: "Aufträge", icon: "clipboard-list", count: 34, href: "#auftraege" },
                { label: "Termine", icon: "calendar", count: appointments.length, current: true },
                { label: "Material", icon: "package", href: "#material" },
              ],
            },
            {
              label: "Arten",
              items: [
                { label: "Abholung", ...kind.pickup, href: "#abholung" },
                { label: "Prüfung", ...kind.check, href: "#pruefung" },
                { label: "Montage", ...kind.fit, href: "#montage" },
                { label: "Aufmaß", ...kind.measure, href: "#aufmass" },
              ],
            },
          ]}
        />
      }
      head={
        <Bar
          start={
            <Tabs
              label="Zeitraum"
              items={[
                { label: "Diese Woche", count: appointments.length, current: true },
                { label: "Nächste Woche", count: 11, href: "#naechste" },
              ]}
            />
          }
          end={
            <Button variant="primary" icon="plus" href="#neu">
              Neuer Termin
            </Button>
          }
        />
      }
      primary={{ label: "Neuer Termin", icon: "plus", href: "#neu" }}
    >
      <Pane.Split>
        <Pane
          label="Termine"
          width={{ min: 320, default: 400 }}
          status={<StatusRow lead="2 heute" facts={[{ value: appointments.length, after: "diese Woche" }]} />}
        >
          <List label="Termine">
            {appointments.map((appointment) => (
              <Row
                mark={kind[appointment.kind]}
                lines={[appointment.customer, `${appointment.work} · ${appointment.fitter}`]}
                time={appointment.day}
                marks={appointment.clash ? <Chip status="warn">Überschneidung</Chip> : undefined}
                href={`#${appointment.id}`}
              />
            ))}
          </List>
        </Pane>
        {/* The form beside the list keeps the list in view while it is filled in; a form over the page is a `Dialog`. */}
        <Pane
          detail
          label="Neuer Termin"
          back={{ label: "Termine", href: "#termine" }}
          head={
            <Bar
              start={<Text type="lead">Neuer Termin</Text>}
              end={<Button variant="ghost" icon="x" label="Schließen" href="#termine" />}
            />
          }
        >
          <Band>
            <Field name="customer" label="Kunde" required error={errors.customer}>
              <Select options={customers} value={values.customer || undefined} placeholder="Kunde wählen" />
            </Field>
            <Field.Row>
              <Field name="day" label="Tag" required hint="TT.MM.JJJJ" error={errors.day}>
                <DateInput value={values.day} placeholder="27.11.2026" />
              </Field>
              <Field name="time" label="Beginn" optional="Uhr" error={errors.time}>
                <Input value={values.time} placeholder="09:00" />
              </Field>
            </Field.Row>
            <Field name="length" label="Dauer">
              <Select options={["1 Stunde", "2 Stunden", "Halber Tag", "Ganzer Tag"]} value={values.length} />
            </Field>
            <Field name="fitter" label="Monteur">
              <Choice name="fitter" options={["Jonas Wehrle", "Mira Solberg", "Sami Yilmaz", "Wer frei ist"]} value={values.fitter} />
            </Field>
            <Field name="note" label="Notiz" optional="optional">
              <Input multiline value={values.note} placeholder="Was der Monteur vor Ort wissen muss" />
            </Field>
          </Band>
          <Band>
            <Check name="remind-mail" label="Kunde einen Tag vorher per E-Mail erinnern" checked />
            {/* a choice that cannot be taken now is dimmed, and its words say why */}
            <Check name="remind-sms" label="Per SMS erinnern (keine Handynummer hinterlegt)" disabled />
          </Band>
          <Bar
            end={
              <>
                <Button href="#termine">Abbrechen</Button>
                {/* a default button: the page's one primary stays "Neuer Termin" in the head */}
                <Button type="submit" icon="check" busy={props.saving}>
                  Termin anlegen
                </Button>
              </>
            }
          />
        </Pane>
      </Pane.Split>
    </Workspace>
  );
}

// The states that Fibel's Example offers beside the default; the recipe test renders each one as well.
export const states = {
  // sent without a customer and with a closed day: each error stands at its field
  errors: () => (
    <NewAppointment
      values={{ ...draft, customer: "", day: "28.11.2026" }}
      errors={{ customer: "Pflichtfeld.", day: "Samstags ist die Werkstatt geschlossen." }}
    />
  ),
  saving: () => <NewAppointment saving />,
};
