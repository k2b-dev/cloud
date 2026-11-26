// Recipe: list with detail. A sidebar, a head with views and the main action, a list beside the open entry.
// Each source leads with the mark of its kind and shows its state as colour and word; the open one fills its pane with
// figures, facts, its latest events and who changed it. On the phone the detail pane leaves; open the entry as its own
// page (its own route) there. The open entry comes from the address: with none open, the detail's place says so;
// while loading, the list holds its place.
import {
  Avatar,
  Bar,
  Button,
  Cells,
  Chip,
  Digest,
  Facts,
  Inline,
  List,
  Loading,
  Mark,
  Nav,
  Notice,
  Pane,
  Row,
  Section,
  StatusRow,
  Tabs,
  Text,
  Workspace,
} from "@k2b/ui/v2";
import { Show } from "solid-js";

// The app this screen belongs to: its colour tints the page and marks it in the host's rail.
export const app = { color: "#0e7490", icon: "activity" };

// One mark per kind of source, the same in the sidebar, the list and every sentence.
const kind = {
  webhook: { icon: "webhook", color: "#0e7490" },
  poll: { icon: "refresh", color: "#2563eb" },
  mail: { icon: "mail", color: "#7c3aed" },
  file: { icon: "server", color: "#c2410c" },
};
const kindName = { webhook: "Webhook", poll: "Abruf", mail: "Postfach", file: "SFTP" } as const;
const people = {
  ada: { name: "Ada Renz" },
  felix: { name: "Felix Thal" },
  sami: { name: "Sami Yilmaz" },
};

type Source = { id: string; name: string; kind: keyof typeof kind; today: string; seen: string; state: "ok" | "warn" | "bad" };

const sources: Source[] = [
  { id: "s2", name: "Holzwerk Brandt", kind: "poll", today: "seit gestern still", seen: "gestern", state: "bad" },
  { id: "s5", name: "Lieferscheine Kraus", kind: "file", today: "3 Dateien warten", seen: "07:55", state: "warn" },
  { id: "s1", name: "Lackfabrik Nordhaus", kind: "webhook", today: "1.240 Ereignisse heute", seen: "09:42", state: "ok" },
  { id: "s3", name: "Spedition Kraus", kind: "webhook", today: "386 Ereignisse heute", seen: "09:40", state: "ok" },
  { id: "s4", name: "Bestellungen Shop", kind: "webhook", today: "212 Ereignisse heute", seen: "09:38", state: "ok" },
  { id: "s6", name: "rechnung@werkstatt.de", kind: "mail", today: "18 Mails heute", seen: "09:31", state: "ok" },
  { id: "s7", name: "Wetterdienst Ortenau", kind: "poll", today: "96 Abrufe heute", seen: "09:30", state: "ok" },
  { id: "s8", name: "Zeiterfassung Montage", kind: "webhook", today: "74 Ereignisse heute", seen: "09:12", state: "ok" },
  { id: "s9", name: "Bank Geschäftskonto", kind: "poll", today: "4 Abrufe heute", seen: "08:00", state: "ok" },
  { id: "s10", name: "anfrage@werkstatt.de", kind: "mail", today: "7 Mails heute", seen: "08:47", state: "ok" },
  { id: "s11", name: "Maschinen Halle 2", kind: "webhook", today: "1.902 Ereignisse heute", seen: "09:42", state: "ok" },
];
const stateLabel = { ok: "Läuft", warn: "Wartet", bad: "Gestört" } as const;

type Props = { open?: string | null; loading?: boolean };

export default function SourcesScreen(props: Props) {
  // the entry the address names; `null` when it names none
  const open = () => (props.loading || props.open === null ? undefined : sources.find((source) => source.id === (props.open ?? "s2")));
  return (
    <Workspace
      // a detail opens beside the list: the sidebar keeps room for it, and its place says so while none is open
      detail
      detailEmpty={{ icon: "activity", text: "Keine Quelle ausgewählt" }}
      sidebar={
        <Nav
          title="Pulse"
          icon="activity"
          groups={[
            {
              items: [
                { label: "Quellen", icon: "plug", current: true, count: sources.length, dot: "bad" },
                { label: "Ereignisse", icon: "list", href: "#ereignisse" },
                { label: "Regeln", icon: "route", count: 14, href: "#regeln" },
              ],
            },
            {
              label: "Arten",
              items: [
                { label: "Webhooks", ...kind.webhook, href: "#webhooks" },
                { label: "Abrufe", ...kind.poll, href: "#abrufe" },
                { label: "Postfächer", ...kind.mail, href: "#postfaecher" },
                { label: "SFTP", ...kind.file, href: "#sftp" },
              ],
            },
          ]}
        />
      }
      head={
        <Bar
          start={
            <Tabs
              label="Ansichten"
              items={[
                { label: "Alle", count: sources.length, current: true },
                { label: "Gestört", count: 1, href: "#gestoert" },
                { label: "Wartet", count: 1, href: "#wartet" },
              ]}
            />
          }
          end={
            <Button variant="primary" icon="plus">
              Neue Quelle
            </Button>
          }
        />
      }
      primary={{ label: "Neue Quelle", icon: "plus" }}
    >
      <Pane.Split>
        <Pane
          label="Quellen"
          width={{ min: 320, default: 400 }}
          status={
            <StatusRow
              lead={props.loading ? "Wird geladen" : "3.920 Ereignisse heute"}
              facts={props.loading ? [] : [{ value: sources.length, after: "Quellen" }]}
              filters={props.loading ? undefined : <Chip status="bad">1 gestört</Chip>}
            />
          }
        >
          {props.loading ? (
            <Loading rows={8} lines={2} />
          ) : (
            <List label="Quellen">
              {sources.map((source) => (
                <Row
                  mark={kind[source.kind]}
                  lines={[source.name, `${kindName[source.kind]} · ${source.today}`]}
                  time={source.seen}
                  // only what is not fine speaks up; "Läuft" on every row would be noise
                  marks={source.state === "ok" ? undefined : <Chip status={source.state}>{stateLabel[source.state]}</Chip>}
                  current={source.id === open()?.id}
                  href={`#${source.id}`}
                />
              ))}
            </List>
          )}
        </Pane>
        <Show when={open()}>{(source) => <SourceDetail source={source()} />}</Show>
      </Pane.Split>
    </Workspace>
  );
}

/** The open source beside the list; it leaves on the phone, where the source opens as its own page. */
function SourceDetail(props: { source: Source }) {
  const open = props.source;
  return (
    <Pane
      detail
      label={open.name}
      head={
        <Bar
          start={
            <Inline>
              <Mark {...kind[open.kind]} />
              <Text type="lead">{open.name}</Text>
            </Inline>
          }
          end={
            <>
              <Button icon="pencil">Bearbeiten</Button>
              <Button variant="ghost" icon="x" label="Schließen" href="#" />
            </>
          }
        />
      }
    >
      <Notice tone="bad" title="Antwortet nicht" actions={[{ label: "Erneut prüfen", icon: "refresh" }]}>
        Seit gestern, 17:20 kommen keine Ereignisse an. Prüfe die Adresse oder den Schlüssel.
      </Notice>
      <Cells>
        <Cells.Cell
          icon="activity"
          label="Ereignisse, 7 Tage"
          value="1.318"
          meta="heute 0, sonst 220 am Tag"
          trend={{ values: [212, 236, 198, 241, 225, 206, 0], label: "Ereignisse der letzten 7 Tage" }}
        />
        <Cells.Cell icon="clock" label="Zuletzt angekommen" value="gestern, 17:20" meta="vor 16 Std" />
        <Cells.Cell icon="alert-triangle" label="Fehler, 24 h" value="192" meta="alle: Zeitüberschreitung" />
      </Cells>
      <Section icon="settings" title="Angaben">
        <Facts
          items={[
            { label: "Art", value: "Abruf alle 5 Minuten" },
            { label: "Zustand", value: <Chip status={open.state}>{stateLabel[open.state]}</Chip> },
            {
              label: "Zuständig",
              value: (
                <Inline>
                  <Avatar {...people.ada} decorative />
                  <Text>Ada Renz</Text>
                </Inline>
              ),
            },
            { label: "Adresse", value: "api.holzwerk-brandt.de/v2/lager", mono: true },
            { label: "Schlüssel", value: "pk_7f3a…c21", copy: "pk_7f3a9be0c21" },
          ]}
        />
      </Section>
      <Section icon="list" title="Letzte Ereignisse" count={192} more={{ label: "Alle Ereignisse", forward: true }}>
        <Row
          mark={{ icon: "clock-x", color: "#dc2626" }}
          lines={["Zeitüberschreitung", "nach 30 s · GET /v2/lager"]}
          time="09:40"
          marks={<Chip status="bad">Fehler</Chip>}
        />
        <Row
          mark={{ icon: "clock-x", color: "#dc2626" }}
          lines={["Zeitüberschreitung", "nach 30 s · GET /v2/lager"]}
          time="09:35"
          marks={<Chip status="bad">Fehler</Chip>}
        />
        <Row mark={{ icon: "package", color: "#0e7490" }} lines={["38 Bestände angenommen", "Lager Nord · Bestand"]} time="gestern" />
      </Section>
      <Section icon="history" title="Geändert">
        <Digest
          label="Geändert"
          activity={[
            {
              person: people.felix,
              text: (
                <>
                  <Text weight="strong">Felix Thal</Text> hat den Abruf von 15 auf 5 Minuten gestellt
                </>
              ),
              time: "gestern, 16:58",
            },
            {
              person: people.sami,
              text: (
                <>
                  <Text weight="strong">Sami Yilmaz</Text> hat den Schlüssel erneuert
                </>
              ),
              time: "Mo., 10:12",
            },
          ]}
        />
      </Section>
    </Pane>
  );
}

// The states Fibel's Example offers beside the default; the recipe test renders each one as well.
export const states = {
  closed: () => <SourcesScreen open={null} />,
  loading: () => <SourcesScreen loading />,
};
