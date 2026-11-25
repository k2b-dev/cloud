// Recipe: a record (customer file), first tab. RecordHead in the head bar, the record's areas as tabs over the pane,
// the main column beside a side column with the details. What needs a person comes first ("Anstehend").
import {
  Bar,
  Button,
  Canvas,
  Cells,
  Chip,
  Digest,
  Empty,
  Facts,
  Failed,
  Loading,
  Nav,
  Notice,
  Pane,
  RecordHead,
  Row,
  Section,
  Tabs,
  Text,
  Workspace,
} from "@k2b/ui/v2";
import { For, type JSX } from "solid-js";

const area = { money: "#8e1b6f", deliveries: "#c2410c", todo: "#2563eb" };

// What the server loaded for one customer. The screen only places it; `worst` at the end is the same shape at its limits.
type Customer = {
  name: string;
  color: string;
  kinds: string[];
  ids: { label?: string; icon?: string; value: string; copy?: boolean }[];
  customers: number;
  counts: { deliveries: number; money: number };
  note: { text: string; meta: string };
  money: { amount: string; meta: string };
  deliveries: { value: string; meta: string };
  contract: { state: string; meta: string };
  due: { title: string; meta: string; action: string; yours?: boolean; icon: string }[];
  history: { date: string; title: string; state: string; tone?: "ok"; icon: string; text: JSX.Element }[];
  contact: { phone: string; email: string; language: string };
};

// A function: the sample holds JSX, which is made once per screen.
const ottilie = (): Customer => ({
  name: "Ottilie Brandner",
  color: "#1d4ed8",
  kinds: ["Privat"],
  ids: [{ label: "Kunde", value: "7K4QX", copy: true }],
  customers: 412,
  counts: { deliveries: 4, money: 12 },
  note: { text: "Ruft lieber an, als Mails zu schreiben. Abholung nur samstags.", meta: "Ada Renz, 12. Nov." },
  money: { amount: "532,30 €", meta: "1 Rechnung offen" },
  deliveries: { value: "2 laufen", meta: "Abrechnung am 15. Dez." },
  contract: { state: "Gültig", meta: "bis 31. Dez. 2027" },
  due: [
    {
      yours: true,
      icon: "signature",
      title: "Quittung wartet auf Unterschrift",
      meta: "Q-2611-00021 · seit 18. Nov.",
      action: "Zur Quittung",
    },
    { icon: "packages", title: "3 Artikel sind abholbereit", meta: "bis 12. Dez.", action: "Herausgabe vorbereiten" },
  ],
  history: [
    {
      icon: "gavel",
      date: "3. Nov.",
      title: "EL-2611-00009",
      state: "Läuft",
      text: (
        <>
          8 Artikel laufen, die Auktion endet <Text weight="strong">morgen</Text>.
        </>
      ),
    },
    { icon: "check", date: "14. Okt.", title: "EL-2610-00031", state: "Abgerechnet", tone: "ok", text: "Ausgezahlt am 15. Nov." },
  ],
  contact: { phone: "+49 30 5550 142", email: "o.brandner@example.de", language: "Deutsch" },
});

// `empty`: a customer created today, with nothing yet; `loading` and `failed`: the history that loads on its own.
type Props = { customer?: Customer; empty?: boolean; loading?: boolean; failed?: boolean };

export default function CustomerOverview(props: Props) {
  const sample = ottilie();
  const c = () => props.customer ?? sample;
  return (
    <Workspace
      sidebar={
        <Nav
          title="Kunden"
          icon="users"
          groups={[
            {
              items: [
                { label: "Alle Kunden", icon: "users", current: true, count: c().customers },
                { label: "Zuletzt", icon: "clock" },
              ],
            },
          ]}
        />
      }
      head={
        <Bar
          start={<RecordHead name={c().name} avatar={{ name: c().name, color: c().color }} kinds={c().kinds} ids={c().ids} />}
          end={
            <Button variant="primary" icon="plus" menu>
              Neu
            </Button>
          }
        />
      }
      primary={{ label: "Neu", icon: "plus" }}
    >
      <Pane
        label="Kundenakte"
        head={
          <Tabs
            label="Bereiche"
            items={[
              { label: "Überblick", icon: "layout-grid", current: true },
              { label: "Einlieferungen", icon: "package", count: props.empty ? undefined : c().counts.deliveries, href: "#einlieferungen" },
              { label: "Geld", icon: "currency-euro", count: props.empty ? undefined : c().counts.money, href: "#geld" },
            ]}
          />
        }
      >
        {/* Note and key statements span both columns; the split below holds the main and the side column. */}
        <Notice tone="note" icon="pin" title="Notiz" meta={c().note.meta} actions={[{ label: "Bearbeiten" }]}>
          {c().note.text}
        </Notice>
        <Cells>
          <Cells.Cell
            icon="currency-euro"
            color={area.money}
            label="Geld heute"
            value={props.empty ? "0,00 €" : <Chip amount="out">{c().money.amount}</Chip>}
            meta={props.empty ? "nichts offen" : c().money.meta}
            href="#geld"
          />
          <Cells.Cell
            icon="package"
            color={area.deliveries}
            label="Einlieferungen"
            value={props.empty ? "keine" : c().deliveries.value}
            meta={props.empty ? undefined : c().deliveries.meta}
            href="#einlieferungen"
          />
          <Cells.Cell icon="file-text" label="Vertrag" value={<Chip status="ok">{c().contract.state}</Chip>} meta={c().contract.meta} />
        </Cells>
        <Pane.Split>
          <Pane label="Überblick">
            <Section
              icon="checklist"
              color={area.todo}
              title="Anstehend"
              count={props.empty ? undefined : c().due.length}
              actions={[{ label: "Todo anlegen", icon: "plus" }]}
            >
              {props.empty ? (
                <Empty icon="checks" text="Für diesen Kunden steht nichts an." />
              ) : (
                <For each={c().due}>
                  {(due) => <Row yours={due.yours} strong icon={due.icon} lines={[due.title, due.meta]} action={{ label: due.action }} />}
                </For>
              )}
            </Section>
            {/* The history loads on its own: its states stand in this section, the rest of the record stays. */}
            <Section
              icon="list-details"
              color={area.deliveries}
              title="Vorgänge"
              more={props.empty || props.failed ? undefined : { label: "Alle Einlieferungen", forward: true }}
            >
              {props.failed ? (
                <Failed
                  text="Die Vorgänge konnten nicht geladen werden. Die übrige Akte bleibt, wie sie ist."
                  onRetry={() => location.reload()}
                />
              ) : props.loading ? (
                <Loading rows={2} lines={2} />
              ) : props.empty ? (
                <Empty icon="package" text="Noch keine Einlieferung." action={{ label: "Einlieferung erfassen", icon: "plus" }} />
              ) : (
                <Digest
                  items={c().history.map((entry) => ({
                    icon: "package",
                    color: area.deliveries,
                    date: entry.date,
                    title: entry.title,
                    state: { icon: entry.icon, label: entry.state, tone: entry.tone },
                    text: entry.text,
                  }))}
                />
              )}
            </Section>
          </Pane>
          <Pane side label="Angaben" width={{ min: 280, default: 360 }}>
            <Canvas label="Karte mit der Adresse" height={176}>
              <span />
            </Canvas>
            <Section
              icon="phone"
              title="Kontakt"
              actions={[{ label: "Ändern", icon: "pencil" }]}
              more={{ label: "Alle Angaben", meta: "Bank, Person" }}
            >
              <Facts
                items={[
                  { label: "Telefon", value: c().contact.phone, hint: "Standard", copy: c().contact.phone },
                  { label: "E-Mail", value: c().contact.email, copy: c().contact.email },
                  { label: "Sprache", value: c().contact.language },
                ]}
              />
            </Section>
          </Pane>
        </Pane.Split>
      </Pane>
    </Workspace>
  );
}

// The states that Fibel's Example offers beside the default; the recipe test renders each one as well.
export const states = {
  worst: () => <CustomerOverview customer={worst} />,
  empty: () => <CustomerOverview empty />,
  loading: () => <CustomerOverview loading />,
  failed: () => <CustomerOverview failed />,
};

// The realistic worst case of the same customer, for Fibel's Example and the recipe test: names and labels at the length
// people really write them (a name has at most 120 + 120 characters, a display name 160), an address that cannot
// wrap, counts above a thousand and exactly one, a note pasted with a line break, a phone number with extension.
const worst: Customer = {
  name: "Nachlassverwaltung Oberhauser-Wettstein & Söhne Antiquitäten GmbH & Co. KG",
  color: "#7c2d12",
  kinds: ["Gewerblich", "Nachlass", "Stammkunde seit 2009"],
  ids: [
    { label: "Kunde", value: "7K4QX", copy: true },
    { icon: "phone", value: "+49 (0) 7821 555 0142-3189" },
    { label: "USt-IdNr.", value: "DE 123 456 789" },
  ],
  customers: 12840,
  counts: { deliveries: 1284, money: 1 },
  note: {
    text: "Abholung nur nach Rücksprache mit der Testamentsvollstreckerin Frau Đặng Thị Ngọc Hân.\nRechnungen bitte an bartholomew.fitzgerald@northwind-industries-holdings.example.com, nie an die Privatadresse.",
    meta: "Aleksandra Wiśniewska-Kowalczyk, 12. Nov. 2026, 23:59",
  },
  money: { amount: "−12.345.678,90 €", meta: "1.284 Rechnungen offen, 1 überfällig seit 15. Okt." },
  deliveries: { value: "1.284 laufen", meta: "Abrechnung am 15. Dez. · 38.412 von 53.007 verkauft" },
  contract: {
    state: "Läuft am 31. Dez. aus, Verlängerung angefragt",
    meta: "Einlieferungsvertrag VT-2610-00031 · Sonderkonditionen Nachlass",
  },
  due: [
    {
      yours: true,
      icon: "signature",
      title: "Quittung Q-2611-00021 wartet seit 12 Tagen auf die Unterschrift der Testamentsvollstreckerin",
      meta: "bartholomew.fitzgerald@northwind-industries-holdings.example.com",
      action: "Erinnerung an die Testamentsvollstreckerin senden",
    },
    { icon: "packages", title: "1 Artikel ist abholbereit", meta: "J", action: "Herausgabe vorbereiten" },
    {
      icon: "alert-triangle",
      title: "Benachrichtigungseinstellungen",
      meta: "Q3 Board Deck — FINAL (revised) v12 [approved by legal].pdf",
      action: "Ansehen",
    },
  ],
  history: [
    {
      icon: "gavel",
      date: "31. Dez. 2025",
      title: "EL-2611-00009-NACHLASS-VILLA-SONNENHALDE",
      state: "Wartet auf Freigabe durch das Nachlassgericht",
      text: "1.284 Artikel laufen, die Auktion endet morgen; 0 sind verkauft, 1 wurde zurückgezogen.",
    },
    { icon: "check", date: "1. Jan.", title: "EL-1", state: "Abgerechnet", tone: "ok", text: "—" },
    {
      icon: "alert-triangle",
      date: "14. Okt.",
      title: "王秀英",
      state: "Fehler",
      text: "<script>alert(1)</script> &amp; **fett** bleibt Text.",
    },
  ],
  contact: {
    phone: "+49 (0) 7821 555 0142-3189 (Durchwahl Buchhaltung)",
    email: "bartholomew.fitzgerald@northwind-industries-holdings.example.com",
    language: "Vietnamesisch, Dolmetscherin nötig",
  },
};
