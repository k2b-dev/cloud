// Recipe: a table of things with a face. The status row says what matters today with a number and toned chips; each
// row leads with the thing's mark, shows the person in charge as an avatar and its state as colour, symbol and word.
// Each row opens its invoice and, when it is overdue, has one deed; on the phone the table becomes two-line rows with the same mark.
// Empty, loading and failed stand where the rows would stand, and nothing above them moves (see `states` at the end).
import { Bar, Button, Chip, Failed, Input, Nav, Pane, StatusRow, Table, Tabs, Workspace } from "@k2b/ui/v2";

// The app this screen belongs to: its colour tints the page and marks it in the host's rail.
export const app = { name: "Finanzen", color: "#15803d", icon: "coin-euro" };

// One colour per kind of document, the same in every list, card and sentence of the app.
// One mark per kind of document, the same in every list, card and sentence of the app.
const kind = {
  invoice: { icon: "file-invoice", color: "#2563eb" },
  partial: { icon: "receipt-2", color: "#c2410c" },
  service: { icon: "tool", color: "#0e7490" },
};
const people = {
  ada: { name: "Ada Renz" },
  felix: { name: "Felix Thal" },
  lena: { name: "Lena Hartwig" },
  sami: { name: "Sami Yilmaz" },
};

type Invoice = {
  number: string;
  customer: string;
  due: string;
  state: "overdue" | "reminded" | "open" | "partly";
  amount: string;
  owner: { name: string };
  /** The kind of document; a plain invoice when not set. */
  kind?: keyof typeof kind;
};

const invoices: Invoice[] = [
  { number: "RE-0042", customer: "Holzwerk Brandt", due: "12. Nov.", state: "overdue", amount: "1.280,00 €", owner: people.ada },
  {
    number: "RE-0039",
    kind: "partial",
    customer: "Praxis Dr. Lindqvist",
    due: "17. Nov.",
    state: "reminded",
    amount: "2.940,00 €",
    owner: people.felix,
  },
  { number: "RE-0044", customer: "Bäckerei Oswald", due: "23. Nov.", state: "overdue", amount: "318,40 €", owner: people.ada },
  { number: "RE-0047", customer: "Familie Oswald", due: "26. Nov.", state: "open", amount: "420,50 €", owner: people.lena },
  {
    number: "RE-0048",
    kind: "partial",
    customer: "Stadtwerke Auental",
    due: "28. Nov.",
    state: "partly",
    amount: "6.100,00 €",
    owner: people.sami,
  },
  { number: "RE-0051", customer: "Architekturbüro Winter", due: "2. Dez.", state: "open", amount: "140,00 €", owner: people.felix },
  {
    number: "RE-0052",
    kind: "service",
    customer: "Kanzlei Berger & Kern",
    due: "4. Dez.",
    state: "open",
    amount: "1.775,00 €",
    owner: people.ada,
  },
  { number: "RE-0055", customer: "Hotel Seeblick", due: "6. Dez.", state: "open", amount: "3.260,00 €", owner: people.lena },
  {
    number: "RE-0058",
    kind: "partial",
    customer: "Gemeinde Ohlsbach",
    due: "9. Dez.",
    state: "open",
    amount: "12.480,00 €",
    owner: people.sami,
  },
  {
    number: "RE-0061",
    kind: "service",
    customer: "Weingut Hartwig",
    due: "11. Dez.",
    state: "open",
    amount: "890,00 €",
    owner: people.felix,
  },
  { number: "RE-0063", customer: "Autohaus Renz", due: "12. Dez.", state: "open", amount: "2.115,30 €", owner: people.ada },
  { number: "RE-0064", kind: "service", customer: "Physio Kern", due: "15. Dez.", state: "open", amount: "260,00 €", owner: people.lena },
];

// A state is always colour, sign and word together: a status chip, never a bare word.
const stateOf = {
  overdue: { status: "bad", label: "Überfällig" },
  reminded: { status: "warn", label: "Gemahnt" },
  partly: { status: "warn", label: "Teilzahlung" },
  open: { status: "ok", label: "Offen" },
} as const;

type Props = { rows?: Invoice[]; loading?: boolean; failed?: boolean };

export default function OpenInvoices(props: Props) {
  const rows = () => props.rows ?? invoices;
  const ready = () => !props.loading && !props.failed && rows().length > 0;
  return (
    <Workspace
      sidebar={
        <Nav
          title="Finanzen"
          icon="coin-euro"
          groups={[
            {
              items: [
                { label: "Übersicht", icon: "layout-dashboard", href: "#" },
                { label: "Rechnungen", icon: "file-invoice", current: true },
                { label: "Angebote", icon: "file-description", count: 5, href: "#angebote" },
                { label: "Belege", icon: "receipt", count: 23, href: "#belege", dot: "warn" },
              ],
            },
            {
              label: "Konten",
              items: [
                { label: "Geschäftskonto", icon: "building-bank", color: "#15803d", href: "#konto" },
                { label: "Rücklagen", icon: "pig-money", color: "#7c3aed", href: "#ruecklagen" },
                { label: "Kasse Werkstatt", icon: "cash", color: "#c2410c", href: "#kasse" },
              ],
            },
          ]}
          foot={[{ label: "Export für Steuerbüro", icon: "file-export" }]}
        />
      }
      head={
        <Bar
          start={
            <Tabs
              label="Rechnungen"
              items={[
                { label: "Offen", count: 12, current: true },
                { label: "Entwürfe", count: 3, href: "#entwuerfe" },
                { label: "Bezahlt", href: "#bezahlt" },
              ]}
            />
          }
          end={
            <>
              <Input type="search" icon="search" label="Rechnung oder Kunde" placeholder="Rechnung oder Kunde" />
              <Button variant="primary" icon="plus">
                Rechnung
              </Button>
            </>
          }
        />
      }
      primary={{ label: "Rechnung", icon: "plus" }}
    >
      <Pane
        label="Offene Rechnungen"
        status={
          <StatusRow
            lead={props.failed ? "Nicht geladen" : props.loading ? "Wird geladen" : ready() ? "33.000,20 € offen" : "Alles bezahlt"}
            filters={
              ready() ? (
                <>
                  <Chip status="bad">3 überfällig · 4.538,40 €</Chip>
                  <Chip yours icon="mail-forward">
                    2 Mahnungen fällig
                  </Chip>
                </>
              ) : undefined
            }
          />
        }
      >
        {props.failed ? (
          <Failed text="Die Rechnungen konnten nicht geladen werden. Es wurde nichts geändert." onRetry={() => location.reload()} />
        ) : (
          <Table
            label="Offene Rechnungen"
            rows={rows()}
            loading={props.loading && { rows: 8 }}
            // A row opens its invoice by its address; with `onNavigate` beside `href` it would open in place.
            open={(row) => ({ href: `#${row.number}` })}
            empty={{ icon: "receipt", text: "Keine offenen Rechnungen. Neue stehen hier, sobald sie verschickt sind." }}
            // On the phone each invoice is a row of two lines with its mark; seven column widths never fit 390 px.
            phone={(row) => ({
              mark: kind[row.kind ?? "invoice"],
              lines: [row.customer, `${row.number} · fällig am ${row.due}`],
              time: row.amount,
              marks: row.state === "open" ? undefined : <Chip status={stateOf[row.state].status}>{stateOf[row.state].label}</Chip>,
            })}
            // the widths fit beside the sidebar from 1024 px on; below that the table becomes `phone` rows
            columns={[
              {
                title: "Rechnung",
                width: { min: 125, default: 170 },
                // the thing's mark leads its name
                mark: (row) => kind[row.kind ?? "invoice"],
                cell: (row) => row.number,
              },
              { title: "Kunde", width: { min: 150, default: 220 }, cell: (row) => row.customer },
              {
                title: "Zustand",
                width: { min: 125, default: 170 },
                // a chip only where something is off; "offen" is the plain rule of this list
                cell: (row) =>
                  row.state === "open" ? "offen" : <Chip status={stateOf[row.state].status}>{stateOf[row.state].label}</Chip>,
              },
              { title: "Fällig", width: { min: 70, default: 120 }, numeric: true, cell: (row) => row.due, drop: true },
              // the person in charge as a face; the avatar carries the name
              {
                title: "Person",
                width: { min: 100, default: 120 },
                drop: true,
                avatar: (row) => row.owner,
                cell: (row) => row.owner.name.split(" ")[0],
              },
              { title: "Betrag", width: { min: 90, default: 140 }, align: "end", cell: (row) => row.amount },
              {
                title: "Aktion",
                width: { min: 56, default: 80 },
                cell: (row) =>
                  row.state === "overdue" ? (
                    // the one deed of a row as a quiet icon button; its name says what it does
                    <Button variant="ghost" icon="mail-forward" label={`Mahnung für ${row.number} senden`} href={`#remind-${row.number}`} />
                  ) : (
                    ""
                  ),
              },
            ]}
          />
        )}
      </Pane>
    </Workspace>
  );
}

// The states Fibel's Example offers beside the default; the recipe test renders each one as well.
export const states = {
  empty: () => <OpenInvoices rows={[]} />,
  loading: () => <OpenInvoices loading />,
  failed: () => <OpenInvoices failed />,
  worst: () => <OpenInvoices rows={worstInvoices} />,
  one: () => <OpenInvoices rows={[invoices[0]!]} />,
  huge: () => <OpenInvoices rows={hugeInvoices} />,
};

// The realistic worst case for Fibel's Example and the recipe test: customers at the length people write them, an address
// that cannot wrap, amounts in the millions and below zero. `one` is a single invoice; `huge` an unpaginated long list.
const worstInvoices: Invoice[] = [
  {
    number: "RE-2611-0042-NACHLASS-SONNENHALDE",
    customer: "Nachlassverwaltung Oberhauser-Wettstein & Söhne Antiquitäten GmbH & Co. KG",
    due: "31. Dez. 2026",
    state: "overdue",
    owner: people.ada,
    amount: "12.345.678,90 €",
  },
  {
    number: "RE-2611-0043-ERBENGEMEINSCHAFT-OBERHAUSER-WETTSTEIN-NACHLASS",
    customer:
      "Erbengemeinschaft Oberhauser-Wettstein, vertreten durch Rechtsanwältin Dr. Aleksandra Wiśniewska-Kowalczyk, Kanzlei am Markt",
    due: "31. Dez. 2026",
    state: "open",
    owner: people.felix,
    amount: "4.611.686,00 €",
  },
  { number: "RE-1", customer: "J", due: "1. Jan.", state: "open", owner: people.felix, amount: "0,30 €" },
  {
    number: "RE-2611-0051",
    customer: "bartholomew.fitzgerald@northwind-industries-holdings.example.com",
    due: "2. Dez.",
    state: "open",
    owner: people.felix,
    amount: "−42,50 €",
  },
  { number: "RE-2611-0052", customer: "Đặng Thị Ngọc Hân", due: "3. Dez.", state: "overdue", owner: people.ada, amount: "1.284,00 €" },
  { number: "RE-2611-0053", customer: "王秀英", due: "4. Dez.", state: "open", owner: people.felix, amount: "1.000.000,00 €" },
];
const hugeInvoices: Invoice[] = Array.from({ length: 1000 }, (_, index) => ({
  ...invoices[index % 3]!,
  number: `RE-2611-${String(index + 1).padStart(4, "0")}`,
}));
