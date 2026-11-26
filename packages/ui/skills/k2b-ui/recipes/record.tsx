// Recipe: a record (customer file), first tab. RecordHead in the head bar, the record's areas as tabs over the pane,
// the main column beside a side column with the details. What needs a person comes first ("Anstehend"); every thing
// leads with its mark in the colour of its area, and the people who look after the customer stand with their faces.
import {
  Bar,
  Button,
  Cells,
  Chip,
  Digest,
  Empty,
  Facts,
  Failed,
  List,
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

// The app this screen belongs to: its colour tints the page and marks it in the host's rail.
export const app = { name: "Kunden", color: "#2563eb", icon: "users" };

const area = { money: "#8e1b6f", deliveries: "#c2410c", todo: "#2563eb" };
// One mark per category of article, the same in every list of the app.
const category = {
  clock: { icon: "clock-hour-4", color: "#a16207" },
  chair: { icon: "armchair", color: "#7c3aed" },
  painting: { icon: "palette", color: "#db2777" },
  silver: { icon: "glass-full", color: "#0e7490" },
};
type Person = { name: string; color?: string };
const people = {
  ada: { name: "Ada Renz" },
  lena: { name: "Lena Hartwig" },
  felix: { name: "Felix Thal" },
};

// What the server loaded for one customer. The screen only places it; `worst` at the end is the same shape at its
// limits, so the record keeps its look with the names, ids and amounts people really have.
type Customer = {
  name: string;
  color: string;
  kinds: string[];
  ids: { label?: string; icon?: string; value: string; copy?: boolean }[];
  customers: string;
  counts: { deliveries: string; money: string };
  note: { text: string; meta: string };
  money: { amount: string; meta: string };
  deliveries: { value: string; meta: string };
  contract: { label: string; status: "ok" | "warn"; meta: string };
  due: { icon: string; color: string; title: string; meta: string; action: string; yours?: boolean }[];
  history: { date: string; title: string; state: { icon: string; label: string; tone?: "ok" }; text: JSX.Element }[];
  items: {
    mark: { icon: string; color: string };
    name: string;
    meta: string;
    time: string;
    chip?: { status: "ok" | "warn"; label: string };
  }[];
  itemCount: string;
  contact: { phone: string; email: string; address: string; language: string };
  team: { person: Person; role: string }[];
  activity: { person: Person; text: JSX.Element; time: string }[];
};

// A function: the sample holds JSX, which is made once per screen.
const ottilie = (): Customer => ({
  name: "Ottilie Brandner",
  color: "#1d4ed8",
  kinds: ["Privat"],
  ids: [{ label: "Kunde", value: "7K4QX", copy: true }],
  customers: "412",
  counts: { deliveries: "4", money: "12" },
  note: { text: "Ruft lieber an, als Mails zu schreiben. Abholung nur samstags.", meta: "Ada Renz, 12. Nov." },
  money: { amount: "532,30 €", meta: "1 Rechnung offen" },
  deliveries: { value: "2 laufen", meta: "Abrechnung am 15. Dez." },
  contract: { label: "Gültig", status: "ok", meta: "bis 31. Dez. 2027" },
  due: [
    {
      yours: true,
      icon: "signature",
      color: area.todo,
      title: "Quittung wartet auf Unterschrift",
      meta: "Q-2611-00021 · seit 18. Nov.",
      action: "Zur Quittung",
    },
    {
      icon: "packages",
      color: area.deliveries,
      title: "3 Artikel sind abholbereit",
      meta: "bis 12. Dez.",
      action: "Herausgabe vorbereiten",
    },
  ],
  history: [
    {
      date: "3. Nov.",
      title: "EL-2611-00009",
      state: { icon: "gavel", label: "Läuft" },
      text: (
        <>
          8 Artikel laufen, die Auktion endet <Text weight="strong">morgen</Text>.
        </>
      ),
    },
    {
      date: "14. Okt.",
      title: "EL-2610-00031",
      state: { icon: "check", label: "Abgerechnet", tone: "ok" },
      text: "Ausgezahlt am 15. Nov.",
    },
  ],
  items: [
    {
      mark: category.clock,
      name: "Standuhr, Schwarzwald um 1880",
      meta: "EL-2611-00009 · Auktion endet morgen",
      time: "Gebot 1.450 €",
      chip: { status: "ok", label: "7 Gebote" },
    },
    { mark: category.chair, name: "Biedermeier-Sessel, Paar", meta: "EL-2611-00009 · im Katalog", time: "Schätzung 900 €" },
    {
      mark: category.painting,
      name: "Ölbild „Rheinauen“, signiert",
      meta: "EL-2611-00009 · Fotos fehlen",
      time: "Schätzung 600 €",
      chip: { status: "warn", label: "Ohne Fotos" },
    },
    { mark: category.silver, name: "Silberbesteck, 84 Teile", meta: "EL-2611-00009 · abholbereit", time: "verkauft 2.100 €" },
  ],
  itemCount: "8",
  contact: { phone: "+49 30 5550 142", email: "o.brandner@post.example", address: "Lindenallee 14, 77933 Lahr", language: "Deutsch" },
  team: [
    { person: people.ada, role: "Beratung und Verträge" },
    { person: people.lena, role: "Fotos und Katalog" },
  ],
  activity: [
    {
      person: people.felix,
      text: (
        <>
          <Text weight="strong">Felix Thal</Text> hat ein Gebot für die <Text weight="strong">Standuhr</Text> angenommen
        </>
      ),
      time: "heute, 09:12",
    },
    {
      person: people.ada,
      text: (
        <>
          <Text weight="strong">Ada Renz</Text> hat die Notiz geändert
        </>
      ),
      time: "12. Nov.",
    },
  ],
});

// `empty`: a customer created today, with nothing yet; `loading` and `failed`: the history that loads on its own.
type Props = { customer?: () => Customer; empty?: boolean; loading?: boolean; failed?: boolean };

export default function CustomerOverview(props: Props) {
  const customer = (props.customer ?? ottilie)();
  return (
    <Workspace
      sidebar={
        <Nav
          title="Kunden"
          icon="users"
          groups={[
            {
              items: [
                { label: "Alle Kunden", icon: "users", current: true, count: customer.customers },
                { label: "Zuletzt", icon: "clock", href: "#zuletzt" },
                { label: "Abholbereit", icon: "packages", count: 9, dot: "warn", href: "#abholbereit" },
              ],
            },
            {
              label: "Listen",
              items: [
                { label: "Privat", icon: "user", color: "#2563eb", count: 318, href: "#privat" },
                { label: "Händler", icon: "building-store", color: "#c2410c", count: 64, href: "#haendler" },
                { label: "Nachlässe", icon: "archive", color: "#7c3aed", count: 30, href: "#nachlaesse" },
              ],
            },
          ]}
        />
      }
      head={
        <Bar
          start={
            <RecordHead
              name={customer.name}
              avatar={{ name: customer.name, color: customer.color }}
              kinds={customer.kinds}
              ids={customer.ids}
            />
          }
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
              {
                label: "Einlieferungen",
                icon: "package",
                count: props.empty ? undefined : customer.counts.deliveries,
                href: "#einlieferungen",
              },
              { label: "Geld", icon: "currency-euro", count: props.empty ? undefined : customer.counts.money, href: "#geld" },
            ]}
          />
        }
      >
        {/* Note and key statements span both columns; the split below holds the main and the side column. */}
        <Notice tone="note" icon="pin" title="Notiz" meta={customer.note.meta} actions={[{ label: "Bearbeiten" }]}>
          {customer.note.text}
        </Notice>
        <Cells>
          <Cells.Cell
            icon="currency-euro"
            color={area.money}
            label="Geld heute"
            // an amount is a number, not a pill
            value={props.empty ? "0,00 €" : customer.money.amount}
            meta={props.empty ? "nichts offen" : customer.money.meta}
            href="#geld"
          />
          <Cells.Cell
            icon="package"
            color={area.deliveries}
            label="Einlieferungen"
            value={props.empty ? "keine" : customer.deliveries.value}
            meta={props.empty ? undefined : customer.deliveries.meta}
            href="#einlieferungen"
          />
          <Cells.Cell
            icon="file-text"
            label="Vertrag"
            value={<Chip status={customer.contract.status}>{customer.contract.label}</Chip>}
            meta={customer.contract.meta}
          />
        </Cells>
        <Pane.Split>
          <Pane label="Überblick">
            <Section
              icon="checklist"
              color={area.todo}
              title="Anstehend"
              count={props.empty ? undefined : customer.due.length}
              actions={[{ label: "Todo anlegen", icon: "plus" }]}
            >
              {props.empty ? (
                <Empty icon="checks" text="Für diesen Kunden steht nichts an." />
              ) : (
                <For each={customer.due}>
                  {(due) => (
                    <Row
                      yours={due.yours}
                      strong
                      mark={{ icon: due.icon, color: due.color }}
                      lines={[due.title, due.meta]}
                      action={{ label: due.action }}
                    />
                  )}
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
                // each delivery as a row: its id over the sentence, the date at the end, its state as a chip
                <List label="Vorgänge">
                  <For each={customer.history}>
                    {(entry) => (
                      <Row
                        mark={{ icon: "package", color: area.deliveries }}
                        lines={[entry.title, entry.text]}
                        time={entry.date}
                        marks={
                          entry.state.tone ? <Chip status={entry.state.tone}>{entry.state.label}</Chip> : <Chip>{entry.state.label}</Chip>
                        }
                      />
                    )}
                  </For>
                </List>
              )}
            </Section>
            <Section
              icon="armchair"
              title="Im Haus"
              count={props.empty ? undefined : customer.itemCount}
              more={props.empty ? undefined : { label: "Alle Artikel", forward: true }}
            >
              {props.empty ? (
                <Empty icon="armchair" text="Noch kein Artikel im Haus." />
              ) : (
                <List label="Im Haus">
                  <For each={customer.items}>
                    {(item, index) => (
                      <Row
                        mark={item.mark}
                        lines={[item.name, item.meta]}
                        time={item.time}
                        marks={item.chip && <Chip status={item.chip.status}>{item.chip.label}</Chip>}
                        href={`#a-${index() + 1}`}
                      />
                    )}
                  </For>
                </List>
              )}
            </Section>
          </Pane>
          <Pane side label="Angaben" width={{ min: 280, default: 360 }}>
            <Section
              icon="phone"
              title="Kontakt"
              actions={[{ label: "Ändern", icon: "pencil" }]}
              more={{ label: "Alle Angaben", meta: "Bank, Person" }}
            >
              <Facts
                items={[
                  { label: "Telefon", value: customer.contact.phone, hint: "Standard", copy: customer.contact.phone },
                  { label: "E-Mail", value: customer.contact.email, copy: customer.contact.email },
                  { label: "Adresse", value: customer.contact.address },
                  { label: "Sprache", value: customer.contact.language },
                ]}
              />
            </Section>
            <Section icon="users" title="Betreut von" count={customer.team.length}>
              <List label="Betreut von">
                <For each={customer.team}>{(member) => <Row avatar={member.person} lines={[member.person.name, member.role]} />}</For>
              </List>
            </Section>
            <Section icon="activity" title="Aktivität" count="diese Woche">
              {props.empty ? (
                <Empty icon="activity" text="Hier steht, wer was an dieser Akte getan hat." />
              ) : (
                <Digest label="Aktivität" activity={customer.activity} />
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
  worst: () => <CustomerOverview customer={worst} />,
  empty: () => <CustomerOverview empty />,
  loading: () => <CustomerOverview loading />,
  failed: () => <CustomerOverview failed />,
};

// The realistic worst case of the same customer, for Fibel's Example and the recipe test: names at the length people
// really write them, one letter, right-to-left and Chinese script, emoji joined into one sign, amounts of ten digits,
// ids that cannot wrap, and a person whose account was deleted.
const deleted = { name: "Gelöschte Person", initials: "?", color: "#71717a" };
const worst = (): Customer => ({
  name: "Nachlassverwaltung Oberhauser-Wettstein & Söhne Antiquitätenhandelsgesellschaft mbH & Co. KG",
  color: "#7c2d12",
  kinds: ["Gewerblich", "Nachlass", "Stammkunde seit 2009"],
  ids: [
    { label: "Kunde", value: "7K4QX-2026-NACHLASS-OBERHAUSER-000001", copy: true },
    { icon: "phone", value: "+49 (0) 7821 555 0142-3189" },
  ],
  customers: "12.840",
  counts: { deliveries: "1.284", money: "1" },
  note: {
    text: "Ansprechpartnerin ist ليلى عبد الرحمن, sie spricht Arabisch und Deutsch. Rechnungen nur an bartholomew.fitzgerald@northwind-industries-holdings.example.com.",
    meta: "Aleksandra Wiśniewska-Kowalczyk, 12. Nov. 2026, 23:59",
  },
  money: { amount: "−1.234.567.890,12 €", meta: "1.284 Rechnungen offen, 1 überfällig seit 15. Okt." },
  deliveries: { value: "1.284 laufen", meta: "Abrechnung am 15. Dez. · 38.412 von 53.007 verkauft" },
  contract: { label: "Läuft am 31. Dez. aus, Verlängerung angefragt", status: "warn", meta: "VT-2610-00031-SONDERKONDITIONEN-NACHLASS" },
  due: [
    {
      yours: true,
      icon: "signature",
      color: area.todo,
      title: "Quittung Q-2611-00021 wartet seit 12 Tagen auf die Unterschrift der Testamentsvollstreckerin",
      meta: "bartholomew.fitzgerald@northwind-industries-holdings.example.com",
      action: "Erinnerung an die Testamentsvollstreckerin senden",
    },
    { icon: "packages", color: area.deliveries, title: "1 Artikel ist abholbereit", meta: "J", action: "Herausgabe vorbereiten" },
    { icon: "phone", color: area.todo, title: "👩‍👩‍👧‍👦 Familie wartet auf Rückruf", meta: "seit gestern, 18:02", action: "Anrufen" },
  ],
  history: [
    {
      date: "31. Dez. 2025",
      title: "EL-2611-00009-NACHLASS-VILLA-SONNENHALDE",
      state: { icon: "hourglass", label: "Wartet auf Freigabe durch das Nachlassgericht" },
      text: "1.284 Artikel laufen, die Auktion endet morgen; 0 sind verkauft, 1 wurde zurückgezogen.",
    },
    { date: "1. Jan.", title: "王秀英的瓷器收藏", state: { icon: "check", label: "Abgerechnet", tone: "ok" }, text: "—" },
  ],
  items: [
    {
      mark: category.silver,
      name: "Tafelsilber der Familie Oberhauser-Wettstein, vollständiges Service für vierundzwanzig Personen mit Monogramm",
      meta: "EL-2611-00009-NACHLASS-VILLA-SONNENHALDE · im Katalog",
      time: "Schätzung 1.234.567.890 €",
      chip: { status: "warn", label: "Gutachten fehlt" },
    },
    { mark: category.painting, name: "青花瓷瓶, 清代", meta: "EL-1 · Fotos fehlen", time: "Schätzung 12.000 €" },
    {
      mark: category.chair,
      name: "سجادة فارسية يدوية",
      meta: "EL-2611-00012 · abholbereit",
      time: "verkauft 8.400 €",
      chip: { status: "ok", label: "Verkauft" },
    },
    { mark: category.clock, name: "X", meta: "—", time: "0 €" },
  ],
  itemCount: "53.007",
  contact: {
    phone: "+49 (0) 7821 555 0142-3189 (Durchwahl Buchhaltung)",
    email: "bartholomew.fitzgerald@northwind-industries-holdings.example.com",
    address: "Oberhauser-Wettstein-Straße 1234a, Hinterhaus, 3. OG links, 77933 Lahr-Sulz",
    language: "Vietnamesisch, Dolmetscherin nötig",
  },
  team: [
    { person: { name: "Đặng Thị Ngọc Hân" }, role: "Testamentsvollstreckerin, Beratung und Verträge für alle Nachlässe" },
    { person: { name: "Ö" }, role: "Fotos" },
    { person: deleted, role: "Konto gelöscht am 3. Nov." },
  ],
  activity: [
    {
      person: { name: "Mira 👩🏽‍💻 Solberg" },
      text: (
        <>
          <Text weight="strong">Mira 👩🏽‍💻 Solberg</Text> hat 1.284 Artikel aus{" "}
          <Text weight="strong">EL-2611-00009-NACHLASS-VILLA-SONNENHALDE</Text> in den Katalog gestellt
        </>
      ),
      time: "heute, 09:12",
    },
    {
      person: deleted,
      text: (
        <>
          <Text weight="strong">Gelöschte Person</Text> hat die Notiz geändert
        </>
      ),
      time: "12. Nov.",
    },
  ],
});
