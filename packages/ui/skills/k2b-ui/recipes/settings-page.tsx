// Recipe: a settings page of an administration. The state comes first as key numbers, each with colour, symbol and
// word; then the settings by topic: a table where one setting has a value per kind, and `Setting` rows with the name
// and hint on the left and the value beside them, so the page reads at a glance. A side column shows the methods and
// who changed what. The page saves as a whole: a changed setting says what it was.
import {
  Bar,
  Button,
  Cells,
  Check,
  Chip,
  Digest,
  Icon,
  Input,
  Nav,
  Pane,
  Path,
  Row,
  Section,
  Setting,
  Table,
  Text,
  Workspace,
} from "@k2b/ui/v2";

const kinds = [
  {
    key: "guest",
    name: "Gäste",
    icon: "user-question",
    color: "#475569",
    on: true,
    shown: true,
    label: "„Als Gast“",
    accounts: 23,
    expires: "nach 30 Tagen",
  },
  {
    key: "local",
    name: "Lokale Konten",
    icon: "key",
    color: "#0284c7",
    on: true,
    shown: true,
    label: "„Mit Cloud-Konto“",
    accounts: 41,
    expires: "nie",
  },
  {
    key: "ipa",
    name: "FreeIPA",
    icon: "building-fortress",
    color: "#7c3aed",
    on: true,
    shown: false,
    label: "„Mit Firmenkonto“",
    accounts: 128,
    expires: "nach 365 Tagen",
  },
];

// `saved`: nothing changed yet, so there is nothing to save.
type Props = { saved?: boolean };

export default function SigninSettings(props: Props) {
  return (
    <Workspace
      sidebar={
        <Nav
          title="Verwaltung"
          icon="adjustments"
          groups={[
            {
              items: [
                { label: "Übersicht", icon: "gauge" },
                { label: "Apps", icon: "apps", count: 14 },
                {
                  label: "Anmeldung & Sicherheit",
                  items: [
                    { label: "Anmeldung", icon: "login-2", current: true },
                    { label: "Registrierung", icon: "user-plus", count: 2 },
                    { label: "Sicherheit", icon: "shield-lock", dot: "warn" },
                    { label: "FreeIPA", icon: "building-fortress", dot: "ok" },
                    { label: "Linux", icon: "terminal-2" },
                  ],
                },
                { label: "Speicher", icon: "database" },
                { label: "Ausgehende Mail", icon: "mail-forward", dot: "bad" },
                { label: "KI", icon: "sparkles" },
                { label: "Wartung", icon: "tool" },
              ],
            },
          ]}
          foot={[{ label: "Cloud 0.92.1 · aktuell", icon: "circle-check" }]}
        />
      }
      head={
        <Bar
          start={<Path label="Ort" items={[{ label: "Anmeldung & Sicherheit", href: "#sicherheit" }, { label: "Anmeldung" }]} />}
          end={
            <>
              {props.saved ? undefined : <Chip yours>1 Änderung</Chip>}
              <Button variant="ghost" icon="book" href="#anleitung">
                Anleitung
              </Button>
              <Button disabled={props.saved}>Verwerfen</Button>
              <Button variant="primary" disabled={props.saved}>
                Speichern
              </Button>
            </>
          }
        />
      }
      primary={{ label: "Speichern", disabled: props.saved }}
    >
      <Pane label="Anmeldung">
        <Cells>
          <Cells.Cell
            icon="login-2"
            label="Anmeldungen heute"
            value="412"
            meta="6 % mehr als letzten Mittwoch"
            trend={{ values: [14, 10, 24, 58, 70, 52, 44, 55, 40], label: "Anmeldungen je Stunde heute" }}
          />
          <Cells.Cell icon="devices" label="Aktive Sitzungen" value="184" meta="12 an Gemeinschaftsrechnern" />
          <Cells.Cell
            icon="building-fortress"
            color="#7c3aed"
            label="FreeIPA"
            value={<Chip status="ok">Verbunden</Chip>}
            meta="ipa.kolb.internal · 18 ms · geprüft 09:40"
            href="#freeipa"
          />
          <Cells.Cell
            icon="alert-triangle"
            label="Fehlgeschlagen, 24 Std."
            value={<Chip status="warn">7</Chip>}
            meta="1 Konto gesperrt · 5 × Passwort falsch"
          />
        </Cells>
        <Pane.Split>
          <Pane label="Einstellungen">
            <Section icon="users-group" title="Kontoarten" count="3 · 192 Konten" actions={[{ label: "Konten ansehen" }]}>
              <Table
                label="Kontoarten"
                rows={kinds}
                rowKey={(row) => row.key}
                phone={(row) => ({
                  lines: [row.name, `${row.accounts} Konten · ${row.expires}`],
                  mark: { icon: row.icon, color: row.color },
                  marks: row.on ? <Chip status="ok">An</Chip> : <Chip>Aus</Chip>,
                })}
                columns={[
                  {
                    title: "Art",
                    width: { min: 140, default: 170 },
                    mark: (row) => ({ icon: row.icon, color: row.color }),
                    cell: (row) => row.name,
                  },
                  { title: "Anmelden", width: { min: 100, default: 110 }, cell: (row) => <Check switch label="An" checked={row.on} /> },
                  {
                    title: "Auf Anmeldeseite",
                    width: { min: 120, default: 140 },
                    drop: true,
                    cell: (row) => (
                      <Text weight="medium" tone={row.shown ? "ok" : undefined}>
                        <Icon name={row.shown ? "eye" : "eye-off"} /> {row.shown ? "sichtbar" : "versteckt"}
                      </Text>
                    ),
                  },
                  { title: "Bezeichnung", width: { min: 120, default: 150 }, drop: true, cell: (row) => row.label },
                  { title: "Konten", width: { min: 64, default: 72 }, align: "end", cell: (row) => String(row.accounts) },
                  { title: "Ablauf", width: { min: 100, default: 120 }, drop: true, cell: (row) => row.expires },
                ]}
              />
            </Section>
            <Section icon="clock-hour-4" title="Sitzungen">
              <Setting label="Angemeldet bleiben" hint="Danach muss man sich neu anmelden." was={props.saved ? undefined : "12 Std."}>
                <Input type="number" value="8" end={<Text type="meta">Std.</Text>} />
              </Setting>
              <Setting label="Gemeinschaftsrechner" hint="Abmelden, wenn niemand den Rechner nutzt.">
                <Input type="number" value="15" end={<Text type="meta">Min. ohne Eingabe</Text>} />
              </Setting>
            </Section>
            <Section icon="device-mobile-check" title="App-Freigabe" count="6 Geräte gekoppelt">
              <Setting label="Neue Apps fragen" hint="Apps auf Geräten brauchen eine Freigabe vor dem ersten Zugriff.">
                <Check switch label="An" checked />
              </Setting>
              <Setting label="Adresse" hint="Von hier aus wird die Freigabe angefragt.">
                <Input type="url" value="https://cloud.kolb-antik.de" />
              </Setting>
              <Setting label="Admins koppeln direkt" hint="Ohne Bestätigung durch die Person.">
                <Check switch label="Aus" />
              </Setting>
            </Section>
          </Pane>
          <Pane side label="Zustand" width={{ min: 280, default: 340 }}>
            <Section title="Anmeldeverfahren">
              <Row
                mark={{ icon: "password", color: "#0284c7" }}
                lines={["Passwort", "mindestens 12 Zeichen"]}
                marks={<Chip status="ok">An</Chip>}
              />
              <Row
                mark={{ icon: "fingerprint", color: "#0f766e" }}
                lines={["Passkeys", "64 % der Konten nutzen einen"]}
                marks={<Chip status="ok">An</Chip>}
              />
              <Row
                mark={{ icon: "shield-check", color: "#b45309" }}
                lines={["Zweiter Faktor", "Pflicht für Admins · 2 ohne"]}
                marks={<Chip status="warn">Lücke</Chip>}
                href="#sicherheit"
              />
              <Row
                mark={{ icon: "terminal-2", color: "#475569" }}
                lines={["Linux-Anmeldung", "SSH mit Cloud-Konto"]}
                marks={<Chip>Aus</Chip>}
              />
            </Section>
            <Section title="Zuletzt geändert" more={{ label: "Protokoll", forward: true }}>
              <Digest
                label="Zuletzt geändert"
                activity={[
                  {
                    person: { name: "Ada Renz" },
                    text: (
                      <>
                        <Text weight="strong">Ada Renz</Text>: Gäste laufen nach 30 statt 14 Tagen ab
                      </>
                    ),
                    time: "gestern, 16:20",
                  },
                  {
                    person: { name: "Mira Solberg" },
                    text: (
                      <>
                        <Text weight="strong">Mira Solberg</Text>: FreeIPA auf der Anmeldeseite versteckt
                      </>
                    ),
                    time: "Mo., 10:05",
                  },
                  {
                    person: { name: "Tom Oswald" },
                    text: (
                      <>
                        <Text weight="strong">Tom Oswald</Text>: App-Freigabe eingeschaltet
                      </>
                    ),
                    time: "18.11., 14:47",
                  },
                ]}
              />
            </Section>
          </Pane>
        </Pane.Split>
      </Pane>
    </Workspace>
  );
}

// The states that Fibel's Example offers beside the default; the recipe test renders each one as well.
export const states = {
  saved: () => <SigninSettings saved />,
};
