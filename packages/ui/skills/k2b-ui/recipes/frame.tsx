// Recipe: the frame of an app. A sidebar with the app's places, a head with the views as tabs and the one main action,
// a list with its status row beside the open entry. Where the sidebar does not fit beside the columns (a tablet), it
// becomes a drawer behind a button at the start of the head. On the phone the list is the page; an open entry is a page
// of its own with one way back to the list.
import {
  Bar,
  Button,
  Chip,
  Empty,
  Facts,
  Failed,
  Inline,
  List,
  Loading,
  Nav,
  Pane,
  Row,
  Section,
  StatusRow,
  Tabs,
  Text,
  Workspace,
} from "@k2b/ui/v2";

type Order = { id: string; number: string; customer: string; work: string; due: string; state: "ok" | "warn" | "bad" };

const orders: Order[] = [
  { id: "a1", number: "WA-2611-0118", customer: "Tischlerei Aaltonen", work: "Kreissäge, Lager tauschen", due: "heute", state: "bad" },
  { id: "a2", number: "WA-2611-0121", customer: "Familie Oswald", work: "Rasenmäher, Inspektion", due: "28. Nov.", state: "warn" },
  { id: "a3", number: "WA-2611-0124", customer: "Praxis Dr. Lindner", work: "Notstrom, Prüfung", due: "2. Dez.", state: "ok" },
  { id: "a4", number: "WA-2611-0127", customer: "Stadtwerke Auental", work: "Pumpe P3, Dichtung", due: "4. Dez.", state: "ok" },
];
const stateLabel = { ok: "Im Plan", warn: "Wartet auf Teile", bad: "Überfällig" } as const;

type Props = { rows?: Order[]; open?: string | null; loading?: boolean; failed?: boolean };

export default function WorkshopOrders(props: Props) {
  const rows = props.rows ?? orders;
  const ready = !props.loading && !props.failed;
  // What is open comes from the address (here "#a2"); without an open entry the detail is not rendered at all.
  // Keep it `undefined` then, never `false`: a `false` child of Pane.Split still gets a line (k2b-ui gap).
  const open = ready && props.open !== null ? rows.find((order) => order.id === (props.open ?? "a2")) : undefined;
  return (
    <Workspace
      // a detail opens beside the list: the frame keeps its room, so the sidebar does not jump between column and drawer
      detail
      detailEmpty={{ icon: "tool", text: "Kein Auftrag ausgewählt" }}
      sidebarLabel="Breite der Seitenleiste"
      sidebar={
        <Nav
          title="Werkstatt"
          icon="tool"
          groups={[
            {
              items: [
                { label: "Aufträge", icon: "clipboard-list", current: true, count: rows.length, href: "#auftraege" },
                { label: "Termine", icon: "calendar", count: 3, dot: "warn", href: "#termine" },
                { label: "Kunden", icon: "users", href: "#kunden" },
              ],
            },
            {
              label: "Lager",
              action: { label: "Neues Lager", icon: "plus" },
              items: [
                { label: "Halle 1", icon: "building-warehouse", href: "#halle-1" },
                { label: "Transporter", icon: "truck", href: "#transporter" },
                {
                  label: "Mehr",
                  items: [
                    { label: "Archiv", icon: "archive", href: "#archiv" },
                    { label: "Papierkorb", icon: "trash", href: "#papierkorb" },
                  ],
                },
              ],
            },
          ]}
          foot={[{ label: "Einstellungen", icon: "settings", href: "#einstellungen" }]}
        />
      }
      head={
        <Bar
          start={
            <Tabs
              label="Ansichten"
              items={[
                { label: "Offen", count: rows.length, current: true, href: "#offen" },
                { label: "Diese Woche", count: 2, href: "#diese-woche" },
                { label: "Erledigt", href: "#erledigt" },
                {
                  label: "Weitere",
                  count: 3,
                  menu: [
                    { label: "Wartet auf Teile", href: "#wartet" },
                    { label: "Garantie", href: "#garantie" },
                    { label: "Ohne Termin", href: "#ohne-termin" },
                  ],
                },
              ]}
            />
          }
          end={
            <Button variant="primary" icon="plus" href="#neu">
              Neuer Auftrag
            </Button>
          }
        />
      }
      primary={{ label: "Neuer Auftrag", icon: "plus", href: "#neu" }}
    >
      <Pane.Split>
        <Pane
          label="Aufträge"
          width={{ min: 320, default: 400 }}
          scrollKey="werkstatt-auftraege"
          status={
            <StatusRow
              lead={ready ? `${rows.length} offen` : "Offene Aufträge"}
              // one fact in a 400 px column: more of them run into the filter (k2b-ui gap)
              facts={ready && rows.length > 0 ? [{ value: 1, after: "überfällig" }] : []}
              filters={
                <Button variant="ghost" icon="filter" menu>
                  Alle Monteure
                </Button>
              }
            />
          }
        >
          {props.failed ? (
            <Failed text="Aufträge konnten nicht geladen werden. Ansicht und Filter bleiben erhalten." onRetry={() => location.reload()} />
          ) : props.loading ? (
            <Loading rows={4} lines={2} />
          ) : rows.length === 0 ? (
            <Empty
              icon="clipboard-check"
              text="Keine offenen Aufträge."
              action={{ label: "Auftrag anlegen", icon: "plus", href: "#neu" }}
            />
          ) : (
            <List label="Offene Aufträge">
              {rows.map((order) => (
                <Row
                  icon="tool"
                  lines={[order.customer, `${order.number} · ${order.work}`]}
                  time={order.due}
                  current={order.id === open?.id}
                  href={`#${order.id}`}
                />
              ))}
            </List>
          )}
        </Pane>
        {open && (
          <Pane
            detail
            label={open.customer}
            // the one way back on the phone: the list's address without the open entry
            back={{ label: "Offen", href: "#offen" }}
            head={
              <Bar
                start={<Text type="lead">{open.customer}</Text>}
                end={
                  <>
                    <Button icon="pencil" href={`#${open.id}/bearbeiten`}>
                      Bearbeiten
                    </Button>
                    <Button variant="ghost" icon="x" label="Schließen" href="#offen" />
                  </>
                }
              />
            }
            status={
              <Bar
                start={
                  <Inline>
                    <Chip status={open.state}>{stateLabel[open.state]}</Chip>
                    <Text type="meta">fällig {open.due}</Text>
                  </Inline>
                }
              />
            }
          >
            <Section icon="file-description" title="Auftrag">
              <Facts
                items={[
                  { label: "Nummer", value: open.number, copy: open.number },
                  { label: "Arbeit", value: open.work },
                  { label: "Monteur", value: "Jonas Wehrle" },
                ]}
              />
            </Section>
            <Section icon="history" title="Verlauf" count={2} more={{ label: "Ganzer Verlauf", forward: true }}>
              <Row icon="package" lines={["Ersatzteil bestellt", "Lieferung am 27. Nov."]} time="gestern" />
              <Row icon="message" lines={["Kunde informiert", "per Telefon"]} time="Mo." />
            </Section>
          </Pane>
        )}
      </Pane.Split>
    </Workspace>
  );
}

// The states that Fibel's Example offers beside the default; the recipe test renders each one as well.
export const states = {
  closed: () => <WorkshopOrders open={null} />,
  empty: () => <WorkshopOrders rows={[]} />,
  loading: () => <WorkshopOrders loading />,
  failed: () => <WorkshopOrders failed />,
};
