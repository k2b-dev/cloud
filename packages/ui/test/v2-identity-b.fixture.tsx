import {
  Avatar,
  Bar,
  Button,
  Digest,
  Dot,
  Facts,
  Hero,
  List,
  Menu,
  Nav,
  ObjectHead,
  Pane,
  Row,
  Section,
  Spark,
  Table,
  Text,
  type TickState,
  Ticks,
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
  icon: string;
  color: string;
  kind: string;
  people: readonly { name: string }[];
  connected: number;
  usage?: readonly number[];
  last: string;
  stale?: boolean;
};

const clients: readonly Client[] = [
  {
    id: "paperless",
    name: "Paperless",
    icon: "file-invoice",
    color: "#0f766e",
    kind: "Vertraulich",
    people: [people.ar, people.jb],
    connected: 6,
    usage: [1, 2, 2, 3, 2, 4, 3, 5, 4, 6, 5, 6],
    last: "vor 1 Std",
  },
  {
    id: "claude",
    name: "Claude Code",
    icon: "terminal-2",
    color: "#c2410c",
    kind: "Selbst registriert",
    people: [people.to, people.lh],
    connected: 4,
    usage: [0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 3, 4],
    last: "vor 12 Min",
  },
  {
    id: "grafana",
    name: "Grafana",
    icon: "chart-area",
    color: "#7c3aed",
    kind: "Vertraulich",
    people: [people.ms, people.sy],
    connected: 31,
    usage: [20, 22, 25, 24, 26, 28, 27, 29, 30, 30, 31, 31],
    last: "gerade eben",
  },
  {
    id: "nextcloud",
    name: "Nextcloud",
    icon: "cloud",
    color: "#1d4ed8",
    kind: "Vertraulich",
    people: [people.jk, people.ft],
    connected: 97,
    usage: [80, 82, 85, 88, 90, 91, 93, 94, 95, 96, 96, 97],
    last: "gerade eben",
  },
  {
    id: "inspector",
    name: "MCP Inspector",
    icon: "bug",
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
    icon: "cloud-upload",
    color: "#15803d",
    kind: "Dienstkonto",
    people: [],
    connected: 0,
    last: "heute, 06:30",
  },
];

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
              <Text type="body" weight="strong">
                OAuth-Clients
              </Text>
            }
            end={
              <Button variant="primary" icon="plus">
                Neuer Client
              </Button>
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
              cell: (client) => client.name,
              mark: (client) => ({ icon: client.icon, color: client.color }),
            },
            {
              title: "Verbunden",
              width: { min: 108, default: 108 },
              cell: (client) =>
                client.connected > 0 ? (
                  <Avatar.Stack people={client.people} max={2} label={`${client.connected} verbunden`} />
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
                  <Spark values={client.usage} label={`${client.name}: genutzt an ${client.usage.filter(Boolean).length} von 12 Tagen`} />
                ) : (
                  <Text type="meta" muted>
                    {client.id === "backup" ? "täglich 06:30" : "keine Nutzung"}
                  </Text>
                ),
              drop: true,
            },
            { title: "Zuletzt", width: { min: 132, default: 132 }, cell: lastCell, drop: true },
          ]}
          phone={(client) => ({
            lines: [
              client.name,
              `${client.kind} · ${client.connected ? `${client.connected} verbunden` : "niemand verbunden"} · ${client.last}`,
            ],
            mark: { icon: client.icon, color: client.color },
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
              mark={{ icon: "file-invoice", color: "#0f766e" }}
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
          <Section title="Zugriff">
            <Facts items={[{ label: "Wer darf", value: "Ausgewählte Personen und Gruppen" }]} />
            <List label="Zugriff">
              <Row avatar={people.ar} lines={["Ada Renz"]} time="verbunden" />
              <Row mark={{ icon: "users", color: "#475569" }} lines={["Buchhaltung", "Gruppe · 5 Personen"]} />
            </List>
          </Section>
          <Section title="Verbunden" count={6} more={{ label: "Alle trennen" }}>
            <List label="Verbunden">
              <Row avatar={people.ar} lines={["Ada Renz"]} time="vor 1 Std" />
              <Row avatar={people.jb} lines={["Jana Berger"]} time="vor 3 Std" />
              <Row avatar={people.to} lines={["Tom Oswald"]} time="gestern, 16:20" />
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
const today: TickState[] = [...Array.from({ length: 64 }, (): TickState => "ok"), "bad"];

export const PulseScreen = (props: { list?: boolean }) => (
  <Workspace>
    <Pane.Split>
      <Pane
        label="Quellen"
        owner={PULSE}
        width={props.list ? undefined : { min: 480, default: 640 }}
        head={
          <Bar
            start={
              <Text type="body" weight="strong">
                Betrieb Werkstatt Nord
              </Text>
            }
            end={
              <Button variant="primary" icon="plus">
                Neue Quelle
              </Button>
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
            label: "Abrufe heute: 5.766 erfolgreich, 3 fehlgeschlagen, der letzte um 10:42 fehlgeschlagen",
            start: "00:00",
            caption: "Abrufe heute · 5.766 erfolgreich, 3 fehlgeschlagen",
            end: "10:42",
          }}
          exceptions={[
            { status: "ok", count: 6, word: "liefern Daten" },
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
              width: { min: 140, default: 140 },
              cell: (source) => (
                <Ticks
                  values={source.ticks}
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
          <Section title="Alarme" count={2}>
            <List label="Alarme">
              <Row
                mark={{ icon: "bell-ringing", color: "#b91c1c" }}
                lines={["Drucker Halle 2 liefert nicht", "ausgelöst 10:41 · per Mail an Felix Thal und Lena Hartwig"]}
              />
              <Row mark={{ icon: "bell", color: "#475569" }} lines={["Toner unter 10 %", "ruhig · zuletzt ausgelöst 18.11."]} />
            </List>
          </Section>
          <Section title="Letzte Abrufe">
            <Table
              label="Letzte Abrufe"
              rows={[
                { at: "10:42:00", what: "Zeitüberschreitung", took: "15,0 s" },
                { at: "10:41:00", what: "Zeitüberschreitung", took: "15,0 s" },
                { at: "10:40:00", what: "Zeitüberschreitung", took: "15,0 s" },
                { at: "10:39:00", what: "86 Metriken", took: "588 ms" },
              ]}
              columns={[
                { title: "Zeit", cell: (fetch) => fetch.at },
                {
                  title: "Ergebnis",
                  cell: (fetch) =>
                    fetch.what === "Zeitüberschreitung" ? (
                      <Text type="row" tone="bad">
                        {fetch.what}
                      </Text>
                    ) : (
                      fetch.what
                    ),
                },
                { title: "Dauer", align: "end", cell: (fetch) => fetch.took },
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
export const IdentityWorstScreen = (props: { part: "hero" | "head"; bare?: boolean }) => (
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
              values: [0, 0, 0, 1_000_000, 0, 3, 0, 0, 0, 0],
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
