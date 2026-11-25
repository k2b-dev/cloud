// Recipe: a form beside a list. The page's one primary ("Neuer Termin") stays in the head and opened the form; the
// form saves with a default button in its own footer bar. On the phone the form is the page, with one way back.
import { Band, Bar, Button, Check, Choice, DateInput, Field, Input, List, Pane, Row, Select, StatusRow, Text, Workspace } from "@k2b/ui/v2";

type Appointment = { id: string; customer: string; work: string; day: string };

const appointments: Appointment[] = [
  { id: "t1", customer: "Tischlerei Aaltonen", work: "Kreissäge abholen", day: "Do. 26. Nov." },
  { id: "t2", customer: "Praxis Dr. Lindner", work: "Notstrom prüfen", day: "Mo. 30. Nov." },
  { id: "t3", customer: "Stadtwerke Auental", work: "Pumpe P3 einbauen", day: "Do. 3. Dez." },
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
      head={
        <Bar
          start={<Text type="body">Termine</Text>}
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
        <Pane label="Termine" width={{ min: 320, default: 400 }} status={<StatusRow lead="3 diese Woche" />}>
          <List label="Termine">
            {appointments.map((appointment) => (
              <Row icon="calendar" lines={[appointment.customer, appointment.work]} time={appointment.day} href={`#${appointment.id}`} />
            ))}
          </List>
        </Pane>
        {/* k2b-ui gap: Dialog. Until v2 has one, the form is a detail beside the list and its own route on the phone. */}
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
              <Choice name="fitter" options={["Jonas Wehrle", "Mira Kaya", "Wer frei ist"]} value={values.fitter} />
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
