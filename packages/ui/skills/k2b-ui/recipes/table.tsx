// Recipe: a table of things with a face. The status row says what matters today with a number and toned chips; each
// row leads with the thing's mark, shows the person in charge as an avatar and its state as colour, symbol and word.
// Each row opens its invoice and, when it is overdue, has one deed; on the phone the table becomes two-line rows with the same mark.
// Empty, loading and failed stand where the rows would stand, and nothing above them moves (see `states` at the end).
import { Avatar, Bar, Button, Chip, Failed, Inline, Input, Mark, Nav, Pane, StatusRow, Table, Tabs, Text, Workspace } from "@k2b/ui/v2";

// The app this screen belongs to: its colour tints the page and marks it in the host's rail.
export const app = { color: "#15803d", icon: "coin-euro" };

// One colour per kind of document, the same in every list, card and sentence of the app.
const kind = {
  invoice: { icon: "file-invoice", color: "#2563eb" },
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
};

const invoices: Invoice[] = [
  { number: "RE-0042", customer: "Holzwerk Brandt", due: "12. Nov.", state: "overdue", amount: "1.280,00 €", owner: people.ada },
  { number: "RE-0039", customer: "Praxis Dr. Lindqvist", due: "17. Nov.", state: "reminded", amount: "2.940,00 €", owner: people.felix },
  { number: "RE-0044", customer: "Bäckerei Oswald", due: "23. Nov.", state: "overdue", amount: "318,40 €", owner: people.ada },
  { number: "RE-0047", customer: "Familie Oswald", due: "26. Nov.", state: "open", amount: "420,50 €", owner: people.lena },
  { number: "RE-0048", customer: "Stadtwerke Auental", due: "28. Nov.", state: "partly", amount: "6.100,00 €", owner: people.sami },
  { number: "RE-0051", customer: "Architekturbüro Winter", due: "2. Dez.", state: "open", amount: "140,00 €", owner: people.felix },
  { number: "RE-0052", customer: "Kanzlei Berger & Kern", due: "4. Dez.", state: "open", amount: "1.775,00 €", owner: people.ada },
  { number: "RE-0055", customer: "Hotel Seeblick", due: "6. Dez.", state: "open", amount: "3.260,00 €", owner: people.lena },
  { number: "RE-0058", customer: "Gemeinde Ohlsbach", due: "9. Dez.", state: "open", amount: "12.480,00 €", owner: people.sami },
  { number: "RE-0061", customer: "Weingut Hartwig", due: "11. Dez.", state: "open", amount: "890,00 €", owner: people.felix },
  { number: "RE-0063", customer: "Autohaus Renz", due: "12. Dez.", state: "open", amount: "2.115,30 €", owner: people.ada },
  { number: "RE-0064", customer: "Physio Kern", due: "15. Dez.", state: "open", amount: "260,00 €", owner: people.lena },
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
                { label: "Rechnungen", icon: "file-invoice", count: 12, current: true },
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
            facts={ready() ? [{ value: rows().length, after: "Rechnungen" }] : []}
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
              mark: kind.invoice,
              lines: [row.customer, `${row.number} · fällig am ${row.due}`],
              time: row.amount,
              marks: row.state === "open" ? undefined : <Chip status={stateOf[row.state].status}>{stateOf[row.state].label}</Chip>,
            })}
            // the widths fit beside the sidebar from 1024 px on; below that the table becomes `phone` rows
            columns={[
              {
                title: "Rechnung",
                width: { min: 110, default: 120 },
                // the thing's mark leads its name; `Inline` keeps the one gap between them
                cell: (row) => (
                  <Inline>
                    <Mark {...kind.invoice} />
                    <Text>{row.number}</Text>
                  </Inline>
                ),
              },
              { title: "Kunde", width: { min: 130, default: 140 }, cell: (row) => row.customer },
              {
                title: "Zustand",
                width: { min: 110, default: 120 },
                cell: (row) => <Chip status={stateOf[row.state].status}>{stateOf[row.state].label}</Chip>,
              },
              { title: "Fällig", width: { min: 70, default: 80 }, cell: (row) => row.due, drop: true },
              // the person in charge as a face; the avatar carries the name
              { title: "Person", width: { min: 64, default: 64 }, drop: true, cell: (row) => <Avatar {...row.owner} /> },
              { title: "Betrag", width: { min: 90, default: 100 }, align: "end", cell: (row) => row.amount },
              {
                title: "Aktion",
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
};
