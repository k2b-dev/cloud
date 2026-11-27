import {
  Avatar,
  Bar,
  Button,
  Chip,
  Digest,
  Dot,
  Facts,
  Hero,
  Icon,
  List,
  Menu,
  Nav,
  ObjectHead,
  Pane,
  Row,
  Section,
  Spark,
  Table,
  Tabs,
  Text,
  type TickState,
  Ticks,
  Trend,
  Workspace,
} from "../src/v2";

// The two screens of the identity study, direction B "Selbstbewusst" (26.11., v2-identity-study v1), built from the
// real primitives with the study's data: OAuth clients in the administration (shell blue, content OAuth indigo) and
// the sources of a Pulse base. `list`: the list alone, nothing open.

const OAUTH = "#4338ca";
const PULSE = "#1e40af";

const people = {
  ar: { name: "Ada Renz" },
  jb: { name: "Jana Berger" },
  to: { name: "Tom Oswald" },
  lh: { name: "Lena Hartwig" },
  ms: { name: "Mira Solberg" },
  sy: { name: "Sami Yilmaz" },
  jk: { name: "Jonas Kern" },
  ft: { name: "Felix Thal" },
};

const adminNav = (
  <Nav
    title="Administration"
    icon="settings"
    groups={[
      {
        label: "Plattform",
        items: [
          { label: "Grundeinstellungen", icon: "adjustments", href: "#grund" },
          { label: "Speicher", icon: "database", href: "#speicher" },
          { label: "Anmeldung & Zugang", icon: "shield-lock", href: "#anmeldung" },
          { label: "OAuth", icon: "key", href: "#oauth", current: true },
          { label: "Apps", icon: "apps", href: "#apps" },
        ],
      },
    ]}
  />
);

type Client = {
  id: string;
  name: string;
  /** Its sign: the first letter on its colour, as the study draws them; a symbol only where the client has one. */
  icon?: string;
  color: string;
  kind: string;
  people: readonly { name: string }[];
  connected: number;
  usage?: readonly number[];
  last: string;
  stale?: boolean;
};

// use per day over 30 days: the week shows in it, quiet at the weekend; `from` the first day it was used
const weekdays = (peak: number, from = 0) =>
  Array.from({ length: 30 }, (_, day) => (day < from ? 0 : Math.round(peak * [1, 0.95, 1, 0.9, 0.85, 0.35, 0.25][day % 7]!)));

const clients: readonly Client[] = [
  {
    id: "wiki",
    name: "Wiki",
    color: "#0369a1",
    kind: "Vertraulich",
    people: [people.ms, people.jb],
    connected: 58,
    usage: weekdays(58),
    last: "vor 3 Min",
  },
  {
    id: "cli",
    name: "Cloud CLI",
    icon: "cloud",
    color: "#111827",
    kind: "Öffentlich",
    people: [people.jk, people.ft],
    connected: 41,
    usage: weekdays(41),
    last: "vor 2 Min",
  },
  {
    id: "zeit",
    name: "Zeiterfassung",
    color: "#15803d",
    kind: "Vertraulich",
    people: [people.ft, people.sy],
    connected: 31,
    usage: weekdays(31),
    last: "vor 9 Min",
  },
  {
    id: "paperless",
    name: "Paperless",
    color: "#0f766e",
    kind: "Vertraulich",
    people: [people.ar, people.jb],
    connected: 6,
    usage: weekdays(6),
    last: "vor 1 Std",
  },
  {
    id: "claude",
    name: "Claude Code",
    color: "#c2410c",
    kind: "Selbst registriert",
    people: [people.to, people.lh],
    connected: 4,
    usage: weekdays(4, 23),
    last: "vor 12 Min",
  },
  {
    id: "grafana",
    name: "Grafana",
    color: "#7c3aed",
    kind: "Vertraulich",
    people: [people.ms, people.sy],
    connected: 31,
    usage: weekdays(31),
    last: "gerade eben",
  },
  {
    id: "nextcloud",
    name: "Nextcloud",
    color: "#1d4ed8",
    kind: "Vertraulich",
    people: [people.jk, people.ft],
    connected: 97,
    usage: weekdays(97),
    last: "gerade eben",
  },
  {
    id: "drucker",
    name: "Drucker-Terminal",
    color: "#b45309",
    kind: "Gerät",
    people: [people.sy, people.ft],
    connected: 4,
    usage: weekdays(4),
    last: "heute, 07:12",
  },
  {
    id: "inspector",
    name: "MCP Inspector",
    color: "#475569",
    kind: "Selbst registriert",
    people: [],
    connected: 0,
    last: "vor 34 Tagen",
    stale: true,
  },
  {
    id: "backup",
    name: "Backup-Dienst",
    color: "#15803d",
    kind: "Dienstkonto",
    people: [],
    connected: 0,
    last: "heute, 06:30",
  },
];

const clientMark = (client: Client) =>
  client.icon ? { icon: client.icon, color: client.color } : { initial: client.name, color: client.color };
// the kinds that differ from a usual client stand beside its name
const kinds = new Set(["Gerät", "Selbst registriert", "Dienstkonto"]);

// people who used the client per day, 30 days (the detail's history)
const peoplePerDay = [4, 5, 6, 6, 5, 0, 2, 5, 6, 6, 5, 4, 0, 5, 6, 6, 6, 4, 2, 0, 5, 6, 5, 5, 6, 0, 0, 0, 4, 5];

// new connections per day, 30 days, from refresh_token_families.created_at (README: derivable)
const newConnections = [3, 1, 4, 2, 0, 5, 3, 2, 6, 1, 0, 2, 4, 3, 7, 2, 1, 0, 3, 5, 2, 4, 1, 3, 6, 2, 0, 4, 3, 5];

const lastCell = (client: Client) =>
  client.stale ? (
    <Text type="row" tone="warn">
      <Dot status="warn" /> {client.last}
    </Text>
  ) : (
    <Text type="row" muted>
      {client.last}
    </Text>
  );

export const OAuthScreen = (props: { list?: boolean }) => (
  <Workspace sidebar={adminNav}>
    <Pane.Split>
      <Pane
        label="OAuth-Clients"
        owner={OAUTH}
        width={props.list ? undefined : { min: 480, default: 640 }}
        head={
          <Bar
            start={
              <Tabs
                label="OAuth"
                items={[
                  { label: "Clients", icon: "key", count: 10, current: true },
                  { label: "Endpunkte", icon: "arrows-exchange", href: "#endpunkte" },
                ]}
              />
            }
            end={
              <>
                <Button variant="ghost" icon="search" label="Clients suchen" />
                <Button variant="primary" icon="plus">
                  Neuer Client
                </Button>
              </>
            }
          />
        }
      >
        <Hero
          figure="178"
          label="aktive Verbindungen"
          meta="97 Personen · 23 neu in 7 Tagen"
          trend={{
            kind: "bars",
            values: newConnections,
            label: "Neue Verbindungen je Tag, letzte 30 Tage: heute 5, im Schnitt 3",
            start: "27.10.",
            caption: "Neue Verbindungen je Tag",
            end: "heute",
          }}
          exceptions={[
            { icon: "world-plus", count: 2, word: "selbst registriert", who: "Claude Code neu seit Mo." },
            { status: "warn", count: 1, word: "ungenutzt seit 30 Tagen", who: "MCP Inspector" },
          ]}
        />
        <Table
          label="Clients"
          rows={clients}
          rowKey={(client) => client.id}
          current={props.list ? undefined : "paperless"}
          open={(client) => ({ href: `#${client.id}` })}
          columns={[
            {
              title: "Client",
              // the name and its kind beside it stay whole: "Claude Code  Selbst registriert"
              width: { min: 240, default: 290 },
              cell: (client) =>
                kinds.has(client.kind) ? (
                  <>
                    {client.name} <Chip>{client.kind}</Chip>
                  </>
                ) : (
                  client.name
                ),
              mark: clientMark,
            },
            {
              title: "Verbunden",
              width: { min: 108, default: 108 },
              cell: (client) =>
                client.connected > 0 ? (
                  <Avatar.Stack people={client.people} max={2} total={client.connected} label={`${client.connected} verbunden`} />
                ) : (
                  <Text type="meta" muted>
                    {client.kind === "Dienstkonto" ? "Dienstkonto" : "niemand"}
                  </Text>
                ),
              drop: true,
            },
            {
              title: "30 Tage",
              width: { min: 100, default: 100 },
              cell: (client) =>
                client.usage ? (
                  <Spark
                    kind="line"
                    values={client.usage}
                    label={`${client.name}: genutzt an ${client.usage.filter(Boolean).length} von 30 Tagen`}
                  />
                ) : (
                  <Text type="meta" muted>
                    {client.id === "backup" ? "täglich 06:30" : "keine Nutzung"}
                  </Text>
                ),
              drop: true,
            },
            { title: "Zuletzt", width: { min: 122, default: 122 }, cell: lastCell, drop: true },
          ]}
          phone={(client) => ({
            lines: [
              client.name,
              `${client.kind} · ${client.connected ? `${client.connected} verbunden` : "niemand verbunden"} · ${client.last}`,
            ],
            mark: clientMark(client),
          })}
        />
      </Pane>
      {props.list ? undefined : (
        <Pane
          label="Paperless"
          detail
          owner={OAUTH}
          back={{ label: "OAuth-Clients", href: "#oauth" }}
          head={
            <ObjectHead
              mark={{ initial: "Paperless", color: "#0f766e" }}
              name="Paperless"
              meta="Belegablage der Buchhaltung · vertraulich"
              actions={
                <>
                  <Button icon="pencil">Bearbeiten</Button>
                  <Menu items={[{ label: "Geheimnis erneuern" }, { label: "Löschen", danger: true }]} />
                  <Button variant="ghost" icon="x" label="Schließen" />
                </>
              }
              facts={[
                { label: "Verbunden", value: "6 von 6" },
                { label: "Zuletzt", value: "vor 1 Std" },
                { label: "Angelegt", value: "02.10.2026" },
              ]}
            />
          }
        >
          <Section title="Personen je Tag" count="30 Tage">
            <Trend
              kind="bars"
              values={peoplePerDay}
              label="Personen je Tag, letzte 30 Tage: heute 5, an 6 Tagen niemand"
              start="27.10."
              caption="10.11."
              end="heute"
            />
          </Section>
          <Section title="Zugriff">
            <Facts items={[{ label: "Wer darf", value: "Ausgewählte Personen und Gruppen" }]} />
            <List label="Zugriff">
              <Row avatar={people.ar} lines={["Ada Renz"]} meta="Person" time="verbunden" />
              <Row
                mark={{ icon: "users", color: "#475569" }}
                lines={["Buchhaltung"]}
                meta="Gruppe · 5 Personen"
                end={<Avatar.Stack people={[people.jb, people.to, people.lh]} max={3} total={5} label="Buchhaltung: 5 Personen" />}
              />
            </List>
          </Section>
          <Section title="Verbunden" count={6} actions={[{ label: "Alle trennen" }]}>
            <List label="Verbunden">
              {/* since when, when last, and the one deed of a connection: take it away */}
              {[
                { person: people.ar, since: "seit 02.10.", last: "vor 1 Std" },
                { person: people.jb, since: "seit 02.10.", last: "vor 3 Std" },
                { person: people.to, since: "seit 09.10.", last: "gestern, 16:20" },
                { person: people.lh, since: "seit 22.11.", last: "Di., 11:05" },
                { person: people.ms, since: "seit 22.11.", last: "Mo., 09:12" },
                { person: people.sy, since: "seit 14.10.", last: "12.11." },
              ].map((link) => (
                <Row
                  avatar={link.person}
                  lines={[link.person.name]}
                  meta={link.since}
                  time={link.last}
                  end={<Button variant="ghost" icon="plug-connected-x" label={`${link.person.name} trennen`} />}
                />
              ))}
            </List>
          </Section>
          <Section title="Verlauf">
            <Digest
              activity={[
                { person: people.jb, text: "Jana Berger hat sich verbunden", time: "heute, 07:48" },
                { person: people.ar, text: "Ada Renz hat Buchhaltung Zugriff gegeben", time: "22.11.2026" },
                { person: people.jk, text: "Jonas Kern hat das Geheimnis erneuert", time: "14.10.2026" },
              ]}
            />
          </Section>
          <Section title="Technik">
            <Facts
              items={[
                { label: "Art", value: "Vertraulich · verwaltet" },
                {
                  label: "Client-ID",
                  value: "78dde6c4-17af-4aca-af53-59599ec4ffac",
                  mono: true,
                  copy: "78dde6c4-17af-4aca-af53-59599ec4ffac",
                },
                {
                  label: "Weiterleitung",
                  value: "https://belege.example.org/accounts/oidc/cloud/login/callback/",
                  mono: true,
                  copy: "https://belege.example.org/accounts/oidc/cloud/login/callback/",
                },
                { label: "Scopes", value: "openid · profile · email · offline_access", mono: true },
              ]}
            />
          </Section>
        </Pane>
      )}
    </Pane.Split>
  </Workspace>
);

type Source = {
  name: string;
  icon: string;
  color: string;
  state: "ok" | "bad" | "paused" | "new";
  ticks: readonly TickState[];
  values?: string;
};

const ok30: TickState[] = Array.from({ length: 30 }, () => "ok");
const sources: readonly Source[] = [
  {
    name: "Drucker Halle 2",
    icon: "printer",
    color: "#be123c",
    state: "bad",
    ticks: [...ok30.slice(0, 27), "bad", "bad", "bad"],
    values: "3.402",
  },
  { name: "Fräse CNC 1", icon: "tool", color: "#0f766e", state: "ok", ticks: ok30, values: "12.960" },
  { name: "Lackierkabine", icon: "spray", color: "#7c3aed", state: "ok", ticks: ok30, values: "8.640" },
  { name: "Druckluft", icon: "wind", color: "#1d4ed8", state: "ok", ticks: ok30, values: "6.480" },
  { name: "Heizung Halle 1", icon: "flame", color: "#c2410c", state: "ok", ticks: ok30, values: "4.320" },
  { name: "Stromzähler", icon: "bolt", color: "#b45309", state: "ok", ticks: ok30, values: "5.578" },
  { name: "Wetterstation", icon: "cloud-rain", color: "#475569", state: "paused", ticks: Array.from({ length: 30 }, () => "none") },
  { name: "Kühlhaus", icon: "snowflake", color: "#0284c7", state: "new", ticks: Array.from({ length: 30 }, () => "none") },
];

// a state is a dot and a word: colour only for the problem, a good state neutral (identity B, rule 7)
const stateChip = (source: Source) =>
  source.state === "bad" ? (
    <Text type="row" tone="bad">
      <Dot status="bad" /> Fehler
    </Text>
  ) : source.state === "ok" ? (
    <Text type="row">
      <Dot status="ok" /> liefert
    </Text>
  ) : (
    <Text type="row" muted>
      <Dot /> {source.state === "paused" ? "pausiert" : "neu"}
    </Text>
  );

// fetches of today, one tick per 15 minutes from 00:00 to 10:42 (65 of them): the last one failed
// today in 48 half hours: 21 went well, the one from 10:30 failed, the rest of the day has no data yet
const today: TickState[] = [
  ...Array.from({ length: 21 }, (): TickState => "ok"),
  "bad",
  ...Array.from({ length: 26 }, (): TickState => "none"),
];

const pulseNav = (
  <Nav
    title="Pulse"
    icon="activity"
    groups={[
      { items: [{ label: "Alle Basen", icon: "layout-grid", count: 7, href: "#basen" }] },
      {
        label: "Basen",
        items: [
          { label: "Betrieb Werkstatt Nord", icon: "building-factory-2", color: PULSE, href: "#nord", current: true, dot: "bad" },
          { label: "Webshop", icon: "shopping-cart", color: "#15803d", href: "#webshop" },
          { label: "Solaranlage Lager", icon: "solar-panel", color: "#c2410c", href: "#solar" },
          { label: "Fuhrpark", icon: "truck", color: "#be123c", href: "#fuhrpark" },
          { label: "WLAN Campus", icon: "wifi", color: "#0f766e", href: "#wlan" },
          { label: "Druckerflotte", icon: "printer", color: "#475569", href: "#drucker" },
          { label: "Archiv 2025", icon: "archive", color: "#475569", href: "#archiv" },
        ],
      },
    ]}
  />
);

// the values per minute of the last hour (09:43 to 10:42): steady, then nothing from 10:40; one fetch per minute
const perMinute = [...Array.from({ length: 57 }, (_, minute) => 1430 + ((minute * 37) % 23)), 0, 0, 0];
const fetchesPerMinute: TickState[] = [...Array.from({ length: 57 }, (): TickState => "ok"), "bad", "bad", "bad"];

export const PulseScreen = (props: { list?: boolean }) => (
  <Workspace sidebar={pulseNav}>
    <Pane.Split>
      <Pane
        label="Quellen"
        owner={PULSE}
        width={props.list ? undefined : { min: 480, default: 640 }}
        head={
          <Bar
            start={
              <Tabs
                label="Betrieb Werkstatt Nord"
                items={[
                  { label: "Quellen", icon: "plug", count: 8, current: true },
                  { label: "SQL", icon: "code", href: "#sql" },
                  { label: "Abfragen", icon: "bookmark", count: 14, href: "#abfragen" },
                  { label: "Alarme", icon: "bell", count: 6, href: "#alarme" },
                ]}
              />
            }
            end={
              <>
                <Button variant="ghost" icon="search" label="Quellen suchen" />
                <Button variant="primary" icon="plus">
                  Neue Quelle
                </Button>
                <Menu items={[{ label: "Base umbenennen" }, { label: "Base archivieren" }]} />
              </>
            }
          />
        }
      >
        <Hero
          figure="41.380"
          label="Werte heute"
          meta="seit 00:00 · 6.612 Serien"
          trend={{
            kind: "ticks",
            values: today,
            label: "Abrufe heute je halbe Stunde: bis 10:30 ohne Fehler, ab 10:30 fehlgeschlagen",
            start: "00:00",
            caption: "Abrufe je halbe Stunde · 5.766 erfolgreich, 3 fehlgeschlagen",
            end: "24:00",
          }}
          exceptions={[
            // good is neutral: a quiet dot and the words (look rule: state neutral when good)
            { status: "off", count: 6, word: "liefern Daten" },
            { status: "bad", count: 1, word: "Fehler", who: "Drucker Halle 2 seit 10:40" },
            { status: "off", count: 2, word: "ruhen", who: "1 pausiert · 1 neu" },
          ]}
        />
        <Table
          label="Quellen"
          rows={sources}
          rowKey={(source) => source.name}
          current={props.list ? undefined : "Drucker Halle 2"}
          open={(source) => ({ href: `#${source.name}` })}
          columns={[
            { title: "Quelle", cell: (source) => source.name, mark: (source) => ({ icon: source.icon, color: source.color }) },
            { title: "Zustand", width: { min: 150, default: 150 }, cell: stateChip, drop: true },
            {
              title: "Abrufe, 30 Min",
              // the ticks' 140 px and the cell's padding: a narrower column would cut the newest slots
              width: { min: 160, default: 160 },
              cell: (source) => (
                <Ticks
                  slots={source.ticks}
                  label={`${source.name}: ${source.ticks.filter((tick) => tick === "bad").length} von 30 Abrufen fehlgeschlagen`}
                />
              ),
              drop: true,
            },
            { title: "Werte heute", align: "end", width: { min: 108, default: 108 }, cell: (source) => source.values ?? "–", drop: true },
          ]}
          phone={(source) => ({
            lines: [
              source.name,
              source.state === "bad" ? "Fehler seit 10:40 · 3.402 Werte" : `${source.values ? `${source.values} Werte` : "keine Werte"}`,
            ],
            mark: { icon: source.icon, color: source.color },
          })}
        />
      </Pane>
      {props.list ? undefined : (
        <Pane
          label="Drucker Halle 2"
          detail
          owner={PULSE}
          back={{ label: "Quellen", href: "#quellen" }}
          head={
            <ObjectHead
              mark={{ icon: "printer", color: "#be123c" }}
              name="Drucker Halle 2"
              meta="Metrikendpunkt · alle 60 s · 86 Serien"
              actions={
                <>
                  <Button icon="refresh">Jetzt abrufen</Button>
                  <Menu items={[{ label: "Pausieren" }, { label: "Löschen", danger: true }]} />
                  <Button variant="ghost" icon="x" label="Schließen" />
                </>
              }
              problem={{
                title: "Liefert seit 10:40 keine Werte",
                text: "Zeitüberschreitung nach 15 s, 3 Abrufe in Folge · Alarm an Felix Thal und Lena Hartwig",
              }}
            />
          }
        >
          <Section title="Werte je Minute" count="letzte Stunde">
            <Trend
              kind="area"
              values={perMinute}
              failedFrom={57}
              label="Werte je Minute, letzte Stunde: gleichmäßig um 1.440, seit 10:40 keine"
              ticks={{ slots: fetchesPerMinute, label: "Abrufe der letzten Stunde: 57 erfolgreich, die letzten 3 fehlgeschlagen" }}
              start="09:43"
              caption="Abrufe"
              end="10:42"
            />
          </Section>
          <Section title="Alarme" count={2}>
            <List label="Alarme">
              <Row
                mark={{ icon: "bell-ringing", color: "#b91c1c" }}
                lines={["Drucker Halle 2 liefert nicht", "ausgelöst 10:41 · keine Werte seit 2 Min"]}
                states={
                  <Text type="meta" muted>
                    <Avatar.Stack people={[people.ft, people.lh]} label="Felix Thal und Lena Hartwig" /> per Mail benachrichtigt
                  </Text>
                }
              />
              <Row mark={{ icon: "bell", color: "#475569" }} lines={["Toner unter 10 %", "ruhig · zuletzt ausgelöst 18.11."]} />
            </List>
          </Section>
          <Section title="Letzte Abrufe">
            {/* k2b-ui gap: a quiet log list (times in mono, no column head), as the study draws it; G builds Table mono */}
            <Table
              label="Letzte Abrufe"
              rows={[
                { at: "10:42:00", what: "Zeitüberschreitung", took: "15,0 s" },
                { at: "10:41:00", what: "Zeitüberschreitung", took: "15,0 s" },
                { at: "10:40:00", what: "Zeitüberschreitung", took: "15,0 s" },
                { at: "10:39:00", what: "86 Metriken", took: "588 ms" },
                { at: "10:38:00", what: "86 Metriken", took: "604 ms" },
              ]}
              columns={[
                // time and duration as wide as they need: the result takes the rest and stays on one line
                { title: "Zeit", width: { min: 88, default: 88 }, cell: (fetch) => fetch.at },
                {
                  title: "Ergebnis",
                  width: { min: 172, default: 172 },
                  cell: (fetch) =>
                    fetch.what === "Zeitüberschreitung" ? (
                      <Text type="row" tone="bad">
                        <Icon name="x" /> {fetch.what}
                      </Text>
                    ) : (
                      fetch.what
                    ),
                },
                { title: "Dauer", align: "end", width: { min: 80, default: 80 }, cell: (fetch) => fetch.took },
              ]}
            />
          </Section>
          <Section title="Einstellungen">
            <Facts
              items={[
                { label: "Art", value: "Metrikendpunkt" },
                {
                  label: "Ziel",
                  value: "http://drucker-h2.werkstatt.example.org:9100/metrics",
                  mono: true,
                  copy: "http://drucker-h2.werkstatt.example.org:9100/metrics",
                },
                { label: "Abrufintervall", value: "alle 60 s · Zeitlimit 15 s" },
                { label: "Angelegt", value: "03.11.2026 von Felix Thal" },
              ]}
            />
          </Section>
          <Section title="Verlauf">
            <Digest
              activity={[
                { person: people.ft, text: "Felix Thal hat das Zeitlimit auf 15 s gesetzt", time: "18.11.2026" },
                { person: people.ft, text: "Felix Thal hat die Quelle angelegt", time: "03.11.2026" },
              ]}
            />
          </Section>
        </Pane>
      )}
    </Pane.Split>
  </Workspace>
);

// Break-ui for the hero and the head of an open thing: a huge figure, a name without spaces, long words everywhere,
// and a hero with nothing but its figure (no history, no meta, no exceptions), beside the worst case.
// `empty`: the hero of a new app that has no history yet; its drawing's place keeps its height and says so
export const IdentityWorstScreen = (props: { part: "hero" | "head"; bare?: boolean; empty?: boolean }) => (
  <Workspace>
    {props.part === "hero" ? (
      <Pane label="Worst" owner={OAUTH}>
        {props.bare ? (
          <Hero figure="0" label="aktive Verbindungen" />
        ) : (
          <Hero
            figure="12.345.678.901"
            label="aktive Verbindungen über alle Mandanten und Dienstkonten hinweg seit der Einrichtung"
            meta="9.876.543 Personen · 1.234.567 neu in 7 Tagen · 98 Gruppen · 12 Mandanten · 3 Regionen"
            trend={{
              kind: "bars",
              values: props.empty ? [] : [0, 0, 0, 1_000_000, 0, 3, 0, 0, 0, 0],
              empty: "Noch keine Verbindungen gezählt",
              label: "Neue Verbindungen je Tag: ein Tag mit einer Million, sonst fast keine",
              start: "01.01.2026",
              caption: "Neue Verbindungen je Tag über alle Mandanten und Dienstkonten hinweg",
              end: "heute, 23:59",
            }}
            exceptions={[
              {
                icon: "world-plus",
                count: "1.234.567",
                word: "selbst registriert",
                who: "Clientnamenohneleerzeichenundmitsehrvielentextdahinter",
              },
              { status: "warn", count: 98_765, word: "ungenutzt seit 30 Tagen", who: "MCP Inspector, Claude Code, Grafana, Nextcloud" },
              { status: "bad", count: 3, word: "Fehler beim Erneuern des Geheimnisses", who: "seit 01.01.2026, 00:00" },
              { status: "off", count: 12, word: "ruhen" },
            ]}
          />
        )}
      </Pane>
    ) : (
      <Pane
        label="Detail"
        owner={OAUTH}
        head={
          <ObjectHead
            mark={{ initial: "Belegablagederbuchhaltungohneleerzeichen", color: "#0f766e" }}
            name={props.bare ? "P" : "Belegablagederbuchhaltungohneleerzeichenundmitnochmehrtextdahinter"}
            meta={
              props.bare ? undefined : "Belegablage der Buchhaltung, der Lohnbuchhaltung und der Steuerberatung · vertraulich · verwaltet"
            }
            actions={props.bare ? undefined : <Button icon="pencil">Bearbeiten</Button>}
            facts={
              props.bare
                ? undefined
                : [
                    { label: "Verbunden", value: "12.345.678 von 98.765.432" },
                    { label: "Zuletzt", value: "vor 365 Tagen, 23:59" },
                    { label: "Angelegt", value: "31.12.2026, 23:59" },
                  ]
            }
            problem={
              props.bare
                ? undefined
                : {
                    title: "Liefert seit dem 01.01.2026, 00:00 keine Werte, und auch die letzten 1.234 Abrufe sind fehlgeschlagen",
                    text: "Zeitüberschreitung nach 15 s, 1.234 Abrufe in Folge · Alarm an Felix Thal, Lena Hartwig, Ada Renz, Jonas Kern und 12 weitere",
                  }
            }
          />
        }
      >
        <Text>Inhalt</Text>
      </Pane>
    )}
  </Workspace>
);

// The owner's colour at its hardest: light colours whose ink and soft data colour must still be read (#eab308 is the
// yellow of Notebooks), with a hero, the open row of a table and the head of the open thing; and a long figure in a
// list of 480 px beside its detail.
export const OwnerScreen = (props: { color: string }) => (
  <Workspace>
    <Pane.Split>
      <Pane label="Liste" owner={props.color} width={{ min: 480, default: 480 }}>
        <Hero
          figure="12.345.678.901"
          label="Werte heute"
          trend={{ kind: "bars", values: [3, 5, 0, 6, 5, 7, 8], label: "Werte je Tag: von 3 auf 8 gestiegen" }}
        />
        <Table
          label="Quellen"
          rows={sources.slice(0, 3)}
          rowKey={(source) => source.name}
          current="Drucker Halle 2"
          columns={[
            { title: "Quelle", cell: (source) => source.name, mark: (source) => ({ icon: source.icon, color: source.color }) },
            // the soft data of a row in the owner's colour, also on the tint of the open row
            { title: "Abrufe", cell: (source) => <Ticks slots={source.ticks} label={`${source.name}: Abrufe der letzten 30 Minuten`} /> },
          ]}
        />
      </Pane>
      <Pane
        label="Detail"
        detail
        owner={props.color}
        head={<ObjectHead mark={{ icon: "printer", color: props.color }} name="Drucker Halle 2" meta="Metrikendpunkt" />}
      >
        <Facts
          items={[
            { label: "http.response.status_code", value: "200" },
            { label: "Letzte Anmeldung", value: "heute, 09:42" },
            // a line of use in the owner's soft colour (Spark kind line)
            { label: "Nutzung", value: <Spark kind="line" values={[3, 5, 4, 6, 5, 7, 8]} label="Nutzung je Tag: von 3 auf 8 gestiegen" /> },
          ]}
        />
        <Section title="Werte je Minute">
          <Trend kind="area" values={[5, 6, 5, 7, 6, 0]} failedFrom={5} label="Werte je Minute: seit der letzten Minute keine" />
        </Section>
      </Pane>
    </Pane.Split>
  </Workspace>
);

// a history alone in a pane's section: the values of the last hour above their fetches, the last three failed
// (review r3 of #4360: the cut over the first failed fetch)
export const TrendUnderScreen = () => (
  <Workspace>
    <Pane label="Verlauf">
      <Section title="Werte je Minute" count="letzte Stunde">
        <Trend
          kind="area"
          values={perMinute}
          failedFrom={57}
          label="Werte je Minute, letzte Stunde: gleichmäßig um 1.440, seit 10:40 keine"
          ticks={{ slots: fetchesPerMinute, label: "Abrufe der letzten Stunde: 57 erfolgreich, die letzten 3 fehlgeschlagen" }}
          start="09:43"
          caption="Abrufe"
          end="10:42"
        />
      </Section>
    </Pane>
  </Workspace>
);
