// Recipe: a table with a status row. The lead says the one main fact, key figures follow, filters sit at the end.
// Each row has one deed; on the phone the table becomes two-line rows. With no rows, a quiet band says so.
import { Band, Bar, Button, Chip, Pane, StatusRow, Table, Text, Workspace } from "@k2b/ui/v2";

type Invoice = { number: string; customer: string; due: string; overdue: boolean; amount: string };

const invoices: Invoice[] = [
  { number: "RE-2611-0042", customer: "Holzwerk Brandt", due: "12. Nov.", overdue: true, amount: "1.280,00 €" },
  { number: "RE-2611-0047", customer: "Familie Oswald", due: "28. Nov.", overdue: false, amount: "420,50 €" },
  { number: "RE-2611-0051", customer: "Architekturbüro Winter", due: "2. Dez.", overdue: false, amount: "140,00 €" },
];

export default function OpenInvoices() {
  return (
    <Workspace head={<Bar start={<Text type="body">Offene Rechnungen</Text>} />}>
      <Pane
        label="Offene Rechnungen"
        status={
          <StatusRow
            lead={`${invoices.length} offen`}
            facts={[
              { before: "Summe", value: "1.840,50 €" },
              { value: 1, after: "überfällig" },
            ]}
            filters={
              <Button variant="ghost" icon="filter" menu>
                Alle Kunden
              </Button>
            }
          />
        }
      >
        {invoices.length === 0 ? (
          <Band>
            <Text muted>Keine offenen Rechnungen.</Text>
          </Band>
        ) : (
          <Table
            label="Offene Rechnungen"
            rows={invoices}
            // On the phone each invoice is a row of two lines; the widths of six columns never fit 390 px.
            // k2b-ui gap: phone rows take no deed yet, so "Mahnung senden" is not reachable on the phone.
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
