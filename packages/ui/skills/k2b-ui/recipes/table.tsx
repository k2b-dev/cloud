// Recipe: a table with a status row. The lead says the one main fact, key figures follow, filters sit at the end.
// Each row opens its invoice and has one deed; on the phone the table becomes two-line rows that open the invoice.
// Empty, loading and failed stand where the rows would stand, and nothing above them moves (see `states` at the end).
import { Button, Chip, Failed, Pane, StatusRow, Table, Workspace } from "@k2b/ui/v2";

type Invoice = { number: string; customer: string; due: string; overdue: boolean; amount: string };

const invoices: Invoice[] = [
  { number: "RE-2611-0042", customer: "Holzwerk Brandt", due: "12. Nov.", overdue: true, amount: "1.280,00 €" },
  { number: "RE-2611-0047", customer: "Familie Oswald", due: "28. Nov.", overdue: false, amount: "420,50 €" },
  { number: "RE-2611-0051", customer: "Architekturbüro Winter", due: "2. Dez.", overdue: false, amount: "140,00 €" },
];

type Props = { rows?: Invoice[]; loading?: boolean; failed?: boolean };

export default function OpenInvoices(props: Props) {
  const rows = () => props.rows ?? invoices;
  const ready = () => !props.loading && !props.failed && rows().length > 0;
  return (
    <Workspace title="Offene Rechnungen">
      <Pane
        label="Offene Rechnungen"
        status={
          <StatusRow
            lead={props.failed ? "Nicht geladen" : props.loading ? "Wird geladen" : `${rows().length} offen`}
            facts={
              ready()
                ? [
                    { before: "Summe", value: "1.840,50 €" },
                    { value: 1, after: "überfällig" },
                  ]
                : []
            }
            filters={
              <Button variant="ghost" icon="filter" menu>
                Alle Kunden
              </Button>
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
            loading={props.loading && { rows: 3 }}
            // A row opens its invoice by its address; with `onNavigate` beside `href` it would open in place.
            open={(row) => ({ href: `#${row.number}` })}
            empty={{ icon: "receipt", text: "Keine offenen Rechnungen." }}
            // On the phone each invoice is a row of two lines that opens the invoice; six column widths never fit 390 px.
            phone={(row) => ({
              lines: [row.customer, `${row.number} · fällig ${row.due}${row.overdue ? " · überfällig" : ""}`],
              time: row.amount,
            })}
            columns={[
              { title: "Nummer", width: { min: 120, default: 140 }, cell: (row) => row.number, drop: true },
              { title: "Kunde", width: { min: 160, default: 240 }, cell: (row) => row.customer },
              { title: "Fällig", width: { min: 100, default: 120 }, cell: (row) => row.due, drop: true },
              {
                title: "Status",
                width: { min: 120, default: 140 },
                cell: (row) => <Chip status={row.overdue ? "bad" : "warn"}>{row.overdue ? "Überfällig" : "Offen"}</Chip>,
              },
              { title: "Betrag", width: { min: 100, default: 120 }, align: "end", cell: (row) => row.amount },
              {
                title: "Aktion",
                cell: (row) => (
                  <Button variant="text" icon="mail-forward" href={`#remind-${row.number}`}>
                    Mahnung senden
                  </Button>
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
