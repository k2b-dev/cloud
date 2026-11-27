// Recipe: the states of a list, each in the place where the rows stand, so the head and the status row never move.
// Nothing yet and nothing behind a filter are two different sentences with their own way out; loading holds the place
// of the rows that will come; data that failed to load once offers "Erneut versuchen" there and nowhere else. A problem
// a person must fix is a Notice that names the deed; a connection that retries on its own says so in the status row.
import { Bar, Button, Chip, Empty, Failed, List, Loading, Notice, Pane, Row, StatusRow, Tabs, Workspace } from "@k2b/ui/v2";

type Delivery = { id: string; supplier: string; place: string; time: string; state: "ok" | "warn" | "bad" };

const deliveries: Delivery[] = [
  { id: "WE-2611-081", supplier: "Lackfabrik Nordhaus", place: "Tor 1 · 6 Gebinde", time: "07:50", state: "ok" },
  { id: "WE-2611-082", supplier: "Holzwerk Brandt", place: "Tor 2 · 14 Platten", time: "09:40", state: "warn" },
  { id: "WE-2611-083", supplier: "Beschläge Krüger", place: "Tor 1 · 3 Pakete", time: "10:15", state: "ok" },
  { id: "WE-2611-084", supplier: "Spedition Kraus", place: "Tor 2 · 1 Palette, beschädigt", time: "11:05", state: "bad" },
];
const stateLabel = { ok: "Geprüft", warn: "Wartet", bad: "Beschädigt" } as const;

type Props = {
  rows?: Delivery[];
  loading?: boolean;
  failed?: boolean;
  /** Only Tor 2 is shown: an empty list then says that the filter found nothing, not that nothing came. */
  filtered?: boolean;
  /** The scale at gate 2 does not answer: something a person must fix, while the list stays. */
  problem?: boolean;
  /** The live connection dropped and retries on its own. */
  reconnecting?: boolean;
};

export default function IncomingGoods(props: Props) {
  const rows = () => (props.rows ?? deliveries).filter((row) => !props.filtered || row.place.startsWith("Tor 2"));
  return (
    <Workspace
      primary={{ label: "Einlieferung erfassen", icon: "plus", href: "#neu" }}
      head={
        <Bar
          start={
            <Tabs
              label="Zeitraum"
              items={[
                { label: "Heute", current: true, href: "#heute" },
                { label: "Diese Woche", href: "#woche" },
              ]}
            />
          }
          end={
            <Button variant="primary" icon="plus" href="#neu">
              Einlieferung erfassen
            </Button>
          }
        />
      }
    >
      <Pane
        label="Wareneingang"
        status={
          <StatusRow
            lead={props.loading || props.failed ? "Heute" : `${rows().length} angekommen`}
            facts={
              props.reconnecting ? [{ value: "Verbindung unterbrochen", after: "· verbindet neu …" }] : [{ value: 1, after: "beschädigt" }]
            }
            filters={
              props.filtered ? (
                <Chip icon="filter" pressed href="#heute">
                  Nur Tor 2
                </Chip>
              ) : (
                <Button variant="ghost" icon="filter" menu>
                  Alle Tore
                </Button>
              )
            }
          />
        }
      >
        {props.problem && (
          <Notice
            tone="bad"
            title="Waage an Tor 2 antwortet nicht"
            actions={[{ label: "Schlüssel prüfen", forward: true, href: "#waage" }]}
          >
            Seit 10:20 kommen keine Gewichte an. Einlieferungen an Tor 2 brauchen bis dahin ein Gewicht von Hand.
          </Notice>
        )}
        {props.failed ? (
          <Failed
            text="Die Einlieferungen von heute konnten nicht geladen werden. Erfasste Einlieferungen bleiben gespeichert."
            onRetry={() => location.reload()}
          />
        ) : props.loading ? (
          <Loading rows={4} lines={2} />
        ) : rows().length === 0 ? (
          props.filtered ? (
            <Empty icon="filter-off" text="Keine Einlieferung an Tor 2." action={{ label: "Filter zurücksetzen", href: "#heute" }} />
          ) : (
            <Empty
              icon="truck"
              text="Heute ist noch nichts angekommen."
              action={{ label: "Einlieferung erfassen", icon: "plus", href: "#neu" }}
            />
          )
        ) : (
          <List label="Einlieferungen von heute">
            {rows().map((row) => (
              <Row
                icon="truck"
                lines={[row.supplier, row.place]}
                time={row.time}
                href={`#${row.id}`}
                end={<Chip status={row.state}>{stateLabel[row.state]}</Chip>}
              />
            ))}
          </List>
        )}
      </Pane>
    </Workspace>
  );
}

// The states that Fibel's Example offers beside the default; the recipe test renders each one as well.
export const states = {
  empty: () => <IncomingGoods rows={[]} />,
  filtered: () => <IncomingGoods rows={deliveries.filter((row) => row.place.startsWith("Tor 1"))} filtered />,
  loading: () => <IncomingGoods loading />,
  failed: () => <IncomingGoods failed />,
  problem: () => <IncomingGoods problem />,
  reconnecting: () => <IncomingGoods reconnecting />,
};
