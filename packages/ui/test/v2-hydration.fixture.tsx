import { createSignal, Show } from "solid-js";
import {
  Bar,
  Button,
  Check,
  Chip,
  Choice,
  DateInput,
  Digest,
  Facts,
  Field,
  Input,
  List,
  Pane,
  Prose,
  Row,
  Section,
  Select,
  Table,
  Text,
  Workspace,
} from "../src/v2";

// One screen with every primitive the review of #4058 named, rendered on the server and hydrated in the browser:
// rows that open something beside their own controls (H1), a pane that comes and goes (H2), fields in one row and a
// table whose cells are counted (H3), uncontrolled controls (M1), facts (M3), fields of choices (M5), Markdown with
// hostile parts (M6), a row of two lines with marks and a button in the flow (lane D).

declare global {
  /** How often a cell of the table and the probe in the field row were made, on this side of the page. */
  var __k2Made: { cells: number; probe: number } | undefined;
}

const made = () => {
  globalThis.__k2Made ??= { cells: 0, probe: 0 };
  return globalThis.__k2Made;
};

const Probe = () => {
  made().probe++;
  return (
    <Field label="Probe">
      <Input placeholder="Probe" />
    </Field>
  );
};

type Order = { id: string; name: string; sum: string; done: boolean };
const orders: Order[] = [
  { id: "AU-1", name: "Einbauschrank Flur", sum: "180,50 €", done: false },
  { id: "AU-2", name: "Treppe Haus am Hang", sum: "617,00 €", done: true },
];

export function Fixture() {
  const [side, setSide] = createSignal(true);
  const [opened, setOpened] = createSignal("nichts");
  return (
    <Workspace
      head={
        <Bar
          start={<Text weight="strong">Probe</Text>}
          end={
            <Button keep onClick={() => setSide(!side())}>
              Info
            </Button>
          }
        />
      }
    >
      <Pane.Split>
        <Pane label="Liste" width={{ min: 280, default: 360 }}>
          <List label="Einträge">
            <Row
              lines={[
                "Holzwerk Brandt",
                <>
                  Angebot <Text href="#angebot">AN-4471</Text>
                </>,
              ]}
              href="#holzwerk"
              time="09:42"
              end={<Button variant="ghost" icon="dots" label="Mehr zu Holzwerk" onClick={() => setOpened("mehr")} />}
            />
            <Row
              lines={["Jonas Hartwig"]}
              onOpen={() => setOpened("jonas")}
              action={{ label: "Annehmen", onClick: () => setOpened("annehmen") }}
            />
            <Row
              lines={[
                <>
                  Einlieferung <Text href="#einlieferung">EL-2611</Text>
                </>,
              ]}
              href="#zeile"
            />
            <Row
              lines={[
                "Spedition Falk",
                "Lieferavis 4471",
                "Ihre Sendung wird am 23.11. zwischen 7 und 11 Uhr zugestellt, bitte die Rampe frei halten",
              ]}
              time="Mo"
            />
            <Row lines={["Zwei Zeilen", "mit Marken"]} marks={<Chip status="ok">bezahlt</Chip>} />
          </List>
        </Pane>
        <Pane label="Mitte">
          <Digest
            label="Neues"
            items={[
              {
                icon: "truck",
                date: "17. Nov.",
                title: "EL-2611",
                state: { icon: "check", label: "Erfasst" },
                text: (
                  <>
                    Quittung <Text href="#quittung">Q-21</Text> wartet
                  </>
                ),
                href: "#einlieferung",
              },
            ]}
          />
          <Section title="Auftrag">
            <Field.Row>
              <Field name="kind" label="Art" hint="Bestimmt den Ablauf.">
                <Select options={["Neubau", "Reparatur", "Montage"]} value="Neubau" />
              </Field>
              <Field name="due" label="Fällig am">
                <DateInput value="15.12.2026" />
              </Field>
              <Probe />
            </Field.Row>
            <Field name="delivery" label="Übergabe">
              <Choice name="delivery" options={["Abholung", "Lieferung"]} value="Lieferung" />
            </Field>
            <Field name="notify" label="Benachrichtigung">
              <Check label="Kunde benachrichtigen" />
            </Field>
            <Field name="partial" label="Teilweise">
              <Check label="Einige Positionen" checked="mixed" onChange={() => undefined} />
            </Field>
            <Field name="contact" label="Ansprechperson">
              <Input placeholder="Wer nimmt ab?" />
            </Field>
            <Field name="note" label="Notiz">
              <Input multiline value={"\nZwei Zeilen\nzum Aufbau"} />
            </Field>
          </Section>
          <Facts
            items={[
              { label: "Kundennr.", value: "K-1042", copy: "K-1042" },
              { label: "Ort", value: "Auental", hint: "Lager Nord" },
            ]}
          />
          <Prose
            markdown={
              'Guten Tag,\n\n<script>window.__k2Bad = 1</script> <img src=x onerror="window.__k2Bad = 2"> [Link](javascript:alert(1))\n\n![Pixel](https://example.com/pixel.png) [Datei](ftp://example.com/a) [Seite](https://example.com) [Post](mailto:post@example.com)'
            }
          />
          <Table
            label="Aufträge"
            rowKey={(order) => order.id}
            open={(order) => ({ href: `#${order.id}` })}
            columns={[
              {
                title: "Auftrag",
                cell: (order) => {
                  made().cells++;
                  return { lines: [order.name, order.id] };
                },
              },
              {
                title: "Stand",
                cell: (order) => {
                  made().cells++;
                  return <Chip status={order.done ? "ok" : "warn"}>{order.done ? "fertig" : "offen"}</Chip>;
                },
              },
              {
                title: "Betrag",
                align: "end",
                cell: (order) => {
                  made().cells++;
                  return order.sum;
                },
              },
            ]}
            rows={orders}
            // the head of a group stands in the table and in the phone list: each place makes its own
            group={(order) => ({
              key: order.done ? "done" : "open",
              head: () => <Chip status={order.done ? "ok" : "warn"}>{order.done ? "Erledigt" : "Offen"}</Chip>,
              meta: "1",
            })}
            phone={(order) => ({ lines: [order.name, order.sum] })}
          />
          <Button>Für sich</Button>
          <Text muted>Geöffnet: {opened()}</Text>
        </Pane>
        <Show when={side()}>
          <Pane label="Info" side width={{ min: 240, default: 280 }}>
            <Section title="Info" />
          </Pane>
        </Show>
      </Pane.Split>
    </Workspace>
  );
}
