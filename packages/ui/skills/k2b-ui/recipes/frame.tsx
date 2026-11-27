// Recipe: the frame of an app. A sidebar with the app's places, a head with the views as tabs and the one main action,
// a list with its status row beside the open entry. Where the sidebar does not fit beside the columns (a tablet), it
// becomes a drawer behind a button at the start of the head. On the phone the list is the page; an open entry is a page
// of its own with one way back to the list.
import {
  Avatar,
  Bar,
  Button,
  Cells,
  Chip,
  Digest,
  Empty,
  Facts,
  Failed,
  Inline,
  List,
  Loading,
  Mark,
  Nav,
  Pane,
  Row,
  Section,
  StatusRow,
  Tabs,
  Text,
  Workspace,
} from "@k2b/ui/v2";

// The app this screen belongs to: its colour tints the page and marks it in the host's rail.
export const app = { color: "#c2410c", icon: "tool" };

// One mark per kind of machine, the same in the list, the detail and every sentence.
const machine = {
  saw: { icon: "wood", color: "#c2410c" },
  mower: { icon: "plant", color: "#15803d" },
  power: { icon: "bolt", color: "#ca8a04" },
  pump: { icon: "droplet", color: "#0e7490" },
  press: { icon: "stack-push", color: "#7c3aed" },
};
const people = {
  jonas: { name: "Jonas Wehrle" },
  mira: { name: "Mira Solberg" },
  sami: { name: "Sami Yilmaz" },
};

type Order = {
  id: string;
  number: string;
  customer: string;
  work: string;
  machine: keyof typeof machine;
  due: string;
  state: "ok" | "warn" | "bad";
};

const orders: Order[] = [
  {
    id: "a1",
    number: "WA-2611-0118",
    customer: "Tischlerei Aaltonen",
    work: "Kreissäge, Lager",
    machine: "saw",
    due: "heute",
    state: "bad",
  },
  {
    id: "a2",
    number: "WA-2611-0121",
    customer: "Familie Oswald",
    work: "Rasenmäher, Inspektion",
    machine: "mower",
    due: "28. Nov.",
    state: "warn",
  },
  {
    id: "a3",
    number: "WA-2611-0124",
    customer: "Praxis Dr. Lindner",
    work: "Notstrom, Prüfung",
    machine: "power",
    due: "2. Dez.",
    state: "ok",
  },
  {
    id: "a4",
    number: "WA-2611-0127",
    customer: "Stadtwerke Auental",
    work: "Pumpe P3, Dichtung",
    machine: "pump",
    due: "4. Dez.",
    state: "ok",
  },
  { id: "a5", number: "WA-2611-0129", customer: "Holzwerk Brandt", work: "Bandsäge, Blatt", machine: "saw", due: "4. Dez.", state: "warn" },
  {
    id: "a6",
    number: "WA-2611-0130",
    customer: "Weingut Hartwig",
    work: "Kelterpresse, Wartung",
    machine: "press",
    due: "5. Dez.",
    state: "ok",
  },
  {
    id: "a7",
    number: "WA-2611-0133",
    customer: "Gemeinde Ohlsbach",
    work: "Aufsitzmäher, Riemen",
    machine: "mower",
    due: "6. Dez.",
    state: "ok",
  },
  {
    id: "a8",
    number: "WA-2611-0135",
    customer: "Hotel Seeblick",
    work: "Poolpumpe, Geräusch",
    machine: "pump",
    due: "9. Dez.",
    state: "ok",
  },
  {
    id: "a9",
    number: "WA-2611-0136",
    customer: "Bäckerei Oswald",
    work: "Aggregat, Ölwechsel",
    machine: "power",
    due: "10. Dez.",
    state: "ok",
  },
  {
    id: "a10",
    number: "WA-2611-0139",
    customer: "Kanzlei Berger & Kern",
    work: "Aktenpresse, Prüfung",
    machine: "press",
    due: "12. Dez.",
    state: "ok",
  },
];
const stateLabel = { ok: "Im Plan", warn: "Teile fehlen", bad: "Überfällig" } as const;

type Props = { rows?: Order[]; open?: string | null; loading?: boolean; failed?: boolean };

export default function WorkshopOrders(props: Props) {
  const rows = props.rows ?? orders;
  const ready = !props.loading && !props.failed;
  // What is open comes from the address (here "#a2"); without an open entry the detail is not rendered at all.
  // Keep it `undefined` then, never `false`: a `false` child of Pane.Split still gets a line (k2b-ui gap).
  const open = ready && props.open !== null ? rows.find((order) => order.id === (props.open ?? "a2")) : undefined;
  return (
    <Workspace
      // a detail of at least 440 px opens beside the list; the frame keeps its room, so the sidebar does not jump between
      // column and drawer (on a 1024 px tablet it is a drawer)
      detail={440}
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
                { label: "Halle 1", icon: "building-warehouse", color: "#0e7490", href: "#halle-1" },
                { label: "Transporter", icon: "truck", color: "#7c3aed", href: "#transporter", dot: "warn" },
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
          width={{ min: 360, default: 400 }}
          scrollKey="werkstatt-auftraege"
          status={
            <StatusRow
              lead={ready && rows.length > 0 ? "3 heute fällig" : "Offene Aufträge"}
              // one fact in a 400 px column: more of them run into the filter (k2b-ui gap)
              facts={ready && rows.length > 0 ? [{ value: rows.length, after: "offen" }] : []}
              filters={ready && rows.length > 0 ? <Chip status="bad">1 überfällig</Chip> : undefined}
            />
          }
        >
          {props.failed ? (
            <Failed text="Aufträge konnten nicht geladen werden. Ansicht und Filter bleiben erhalten." onRetry={() => location.reload()} />
          ) : props.loading ? (
            <Loading rows={8} lines={2} />
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
                  mark={machine[order.machine]}
                  lines={[order.customer, `${order.number} · ${order.work}`]}
                  time={order.due}
                  // only what is not in plan speaks up; "Im Plan" on every row would be noise
                  marks={order.state === "ok" ? undefined : <Chip status={order.state}>{stateLabel[order.state]}</Chip>}
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
                start={
                  <Inline>
                    <Mark {...machine[open.machine]} />
                    <Text type="lead">{open.customer}</Text>
                  </Inline>
                }
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
            <Cells>
              <Cells.Cell icon="clock" label="Arbeitszeit" value="1,5 von 3 h" meta="Jonas, gestern" />
              <Cells.Cell icon="package" color="#ca8a04" label="Teile" value="1 von 2 da" meta="Messer kommt am 27. Nov." />
              <Cells.Cell icon="receipt" label="Angebot" value="186,40 €" meta="angenommen am 21. Nov." />
            </Cells>
            <Section icon="file-description" title="Auftrag">
              <Facts
                items={[
                  { label: "Nummer", value: open.number, copy: open.number },
                  { label: "Arbeit", value: open.work },
                  {
                    label: "Monteur",
                    value: (
                      <Inline>
                        <Avatar {...people.jonas} decorative />
                        <Text>Jonas Wehrle</Text>
                      </Inline>
                    ),
                  },
                  { label: "Gerät", value: "Honda HRX 476, Baujahr 2019" },
                ]}
              />
            </Section>
            <Section icon="package" title="Teile" count={2}>
              <Row
                mark={{ icon: "blade", color: "#ca8a04" }}
                lines={["Messerbalken 47 cm", "Bestellt bei Motoristik Kraus · 38,90 €"]}
                time="27. Nov."
                marks={<Chip status="warn">Bestellt</Chip>}
              />
              <Row
                mark={{ icon: "filter", color: "#15803d" }}
                lines={["Luftfilter HRX", "Halle 1 · Regal C4 · 12,40 €"]}
                marks={<Chip status="ok">Im Lager</Chip>}
              />
            </Section>
            <Section icon="history" title="Verlauf" count={3} more={{ label: "Ganzer Verlauf", forward: true }}>
              <Digest
                label="Verlauf"
                activity={[
                  {
                    person: people.jonas,
                    text: (
                      <>
                        <Text weight="strong">Jonas Wehrle</Text> hat das Messer bestellt
                      </>
                    ),
                    time: "gestern, 15:20",
                  },
                  {
                    person: people.mira,
                    text: (
                      <>
                        <Text weight="strong">Mira Solberg</Text> hat Familie Oswald angerufen: abholen ab 28. Nov.
                      </>
                    ),
                    time: "Mo., 11:05",
                  },
                ]}
              />
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
