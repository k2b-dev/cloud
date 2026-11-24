import {
  Bar,
  Button,
  Check,
  Choice,
  DateInput,
  Dialog,
  Field,
  Input,
  Nav,
  Notice,
  Pane,
  Path,
  Section,
  Select,
  Text,
  Workspace,
} from "@k2b/ui/v2";
import { createSignal } from "solid-js";

// A realistic form with the controls of @k2b/ui/v2: a new order in Grids. Fields share one grid, errors stand at the
// field, and "Abbrechen" asks in a dialog before the order is discarded (a sheet on a phone). Only primitives; an island
// so the controls answer. The menu, the open list of a selection and the toast that answers the main action follow.

export default function FormScreen() {
  const [discard, setDiscard] = createSignal(false);
  const [quantity, setQuantity] = createSignal("0");
  const [notify, setNotify] = createSignal(true);
  const [urgent, setUrgent] = createSignal(false);
  const [delivery, setDelivery] = createSignal("Lieferung");
  const quantityError = () => (Number(quantity()) >= 1 ? undefined : "Mindestens 1 Stück.");
  return (
    <Workspace
      sidebarLabel="Breite der Seitenleiste"
      primary={{ label: "Anlegen", icon: "check" }}
      sidebar={
        <Nav
          title="Grids"
          icon="table"
          groups={[
            {
              label: "Werkstatt",
              items: [
                { label: "Aufträge", icon: "table", count: 34, current: true },
                { label: "Material", icon: "table", count: 128 },
                { label: "Kunden", icon: "table", count: 412 },
              ],
            },
          ]}
        />
      }
      head={
        <Bar
          start={
            <Path
              label="Ort"
              items={[{ label: "Werkstatt", href: "#werkstatt" }, { label: "Aufträge", href: "#auftraege" }, { label: "Neuer Auftrag" }]}
            />
          }
          end={
            <>
              <Button onClick={() => setDiscard(true)}>
                Abbrechen
              </Button>
              <Button variant="primary" icon="check" disabled={quantityError() !== undefined}>
                Auftrag anlegen
              </Button>
            </>
          }
        />
      }
    >
      <Pane label="Neuer Auftrag">
        <Notice tone="warn" title="Kunde hat noch offene Rechnungen" actions={[{ label: "Ansehen", forward: true }]}>
          Familie Oswald hat 2 Rechnungen über 1.234,50 € offen, eine davon seit 15. Okt. überfällig.
        </Notice>
        <Section icon="user" color="#2563eb" title="Kunde">
          <Field.Row>
            <Field name="customer" label="Kunde">
              <Select options={["Familie Oswald", "Architekturbüro Winter", "Stadtwerke Auental"]} value="Familie Oswald" />
            </Field>
            <Field name="contact" label="Ansprechperson" optional="optional">
              <Input placeholder="Wer nimmt den Auftrag ab?" />
            </Field>
          </Field.Row>
        </Section>
        <Section icon="hammer" color="#047857" title="Auftrag">
          <Field.Row>
            <Field name="name" label="Bezeichnung" hint="So erscheint der Auftrag in der Liste.">
              <Input value="Einbauschrank Flur" />
            </Field>
            <Field name="quantity" label="Menge" optional="Stück" error={quantityError()}>
              <Input type="number" min={1} value={quantity()} onInput={setQuantity} />
            </Field>
          </Field.Row>
          <Field.Row>
            <Field name="kind" label="Art">
              <Select options={["Neubau", "Reparatur", "Montage"]} value="Neubau" />
            </Field>
            <Field name="due" label="Fällig am">
              <DateInput value="15.12.2026" />
            </Field>
          </Field.Row>
          <Field.Row>
            <Field name="note" label="Notiz" optional="optional">
              <Input multiline placeholder="Was die Werkstatt wissen muss" />
            </Field>
          </Field.Row>
        </Section>
        <Section icon="truck" color="#c2410c" title="Ablauf">
          <Choice
            name="delivery"
            label="Übergabe"
            options={["Abholung", "Lieferung", "Lieferung mit Montage"]}
            value={delivery()}
            onChange={setDelivery}
          />
          <Check name="notify" label="Kunde bei jedem Schritt benachrichtigen" checked={notify()} onChange={setNotify} />
          <Check name="urgent" switch label="Eilig" checked={urgent()} onChange={setUrgent} />
        </Section>
      </Pane>
      <Dialog
        title="Auftrag verwerfen?"
        open={discard()}
        onOpenChange={setDiscard}
        foot={
          <>
            <Button onClick={() => setDiscard(false)}>Weiter bearbeiten</Button>
            <Button variant="primary" onClick={() => setDiscard(false)}>
              Verwerfen
            </Button>
          </>
        }
      >
        <Text>Die Angaben zu diesem Auftrag gehen verloren. Ein verworfener Auftrag lässt sich nicht wiederherstellen.</Text>
      </Dialog>
    </Workspace>
  );
}
