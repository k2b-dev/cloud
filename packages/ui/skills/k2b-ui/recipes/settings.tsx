// Recipe: settings with more than text, as `Setting` rows: the name and a quiet hint on the left, the value beside them
// in one column, so the page reads at a glance. A setting the operator fixed is a dimmed control with the reason in its
// hint, and a changed one says what it was; the page saves as a whole.
// Lists of values are tags, a logo an image, a colour a colour, a share a slider. The head names the page and what it is
// for; a side column shows who changed what. The values live in the app; the primitives only show them.
import {
  Bar,
  Button,
  Chip,
  ColorInput,
  Digest,
  ImageInput,
  Inline,
  Nav,
  Pane,
  Section,
  Select,
  Setting,
  Slider,
  TagsInput,
  Text,
  Workspace,
} from "@k2b/ui/v2";

// The app this screen belongs to: its colour tints the page and marks it in the host's rail.
export const app = { name: "Verwaltung", color: "#2563eb", icon: "adjustments-horizontal" };

// A small logo as a data URL, so the recipe draws without the network.
const logo =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'><rect width='48' height='48' fill='%230f766e'/><path d='M14 34V14h6l8 12V14h6v20h-6l-8-12v12z' fill='white'/></svg>";
const people = {
  ada: { name: "Ada Renz" },
  tom: { name: "Tom Oswald" },
};

type Props = { locked?: boolean; empty?: boolean };

export default function SignInPageSettings(props: Props) {
  // two values differ from what is saved: the page says so in its head and at each setting
  const changes = props.empty || props.locked ? 0 : 2;
  return (
    <Workspace
      sidebar={
        <Nav
          title="Verwaltung"
          icon="adjustments-horizontal"
          groups={[
            {
              items: [
                { label: "Übersicht", icon: "layout-dashboard", href: "#uebersicht" },
                { label: "Apps", icon: "apps", count: 14, href: "#apps" },
                {
                  label: "Anmeldung & Sicherheit",
                  items: [
                    { label: "Anmeldung", icon: "login", href: "#anmeldung" },
                    { label: "Anmeldeseite", icon: "browser", current: true },
                    { label: "Sicherheit", icon: "shield-check", dot: "warn", href: "#sicherheit" },
                    { label: "FreeIPA", icon: "building-fortress", dot: "ok", href: "#freeipa" },
                  ],
                },
                { label: "Speicher", icon: "database", href: "#speicher" },
                { label: "Ausgehende Mail", icon: "mail-forward", dot: "bad", href: "#mail" },
                { label: "KI", icon: "sparkles", href: "#ki" },
              ],
            },
          ]}
        />
      }
      head={
        <Bar
          // the page's title and in one line what it is for; then what is unsaved
          start={
            <Inline>
              <Text type="lead">Anmeldeseite</Text>
              <Text type="meta">Was Personen sehen, bevor sie sich anmelden</Text>
              {changes > 0 && <Chip yours>{`${changes} Änderungen`}</Chip>}
            </Inline>
          }
          end={
            <>
              <Button href="#" disabled={changes === 0}>
                Verwerfen
              </Button>
              {/* k2b-ui gap: a footer Bar that stays at the pane's bottom while there are changes; until then the
                  page's one primary stands in the head, where a long page keeps it in reach */}
              {/* the page's one primary while there is something to save; with nothing changed it waits, dimmed */}
              <Button
                variant={changes > 0 && !props.locked ? "primary" : "secondary"}
                type="submit"
                disabled={changes === 0 || props.locked}
              >
                Speichern
              </Button>
            </>
          }
        />
      }
      // the floating "Speichern" only while there is something to save; it would cover a field for nothing
      primary={changes > 0 && !props.locked ? { label: "Speichern", icon: "check" } : undefined}
    >
      <Pane.Split>
        <Pane label="Anmeldeseite">
          <Section icon="login" title="Zugang">
            <Setting
              name="session"
              label="Angemeldet bleiben"
              // k2b-ui gap: the deed of a field ("Auf Standard zurücksetzen") has no place in a Setting row yet
              hint="Danach melden sich Personen neu an. Standard: 8 Stunden."
              was={changes ? "8 Stunden" : undefined}
            >
              <Select options={["8 Stunden", "24 Stunden", "7 Tage"]} value="7 Tage" disabled={props.locked} />
            </Setting>
            <Setting name="method" label="Verfahren" hint="Legt der Betreiber fest.">
              <Select options={["Passwort und Passkey", "Nur Passkey"]} value="Passwort und Passkey" disabled />
            </Setting>
            <Setting name="domains" label="Erlaubte Domains" hint="Nur Adressen dieser Domains melden sich selbst an.">
              <TagsInput
                value={props.empty ? [] : ["werkstatt.example", "k2b.example"]}
                placeholder="z. B. firma.example"
                disabled={props.locked}
              />
            </Setting>
          </Section>
          <Section icon="palette" title="Aussehen">
            <Setting name="logo" label="Logo" hint="Steht über dem Anmelden, höchstens 2 MB.">
              <ImageInput value={props.empty ? null : logo} onChange={() => undefined} disabled={props.locked} />
            </Setting>
            <Setting name="accent" label="Akzentfarbe" hint="Für Knöpfe und Links der Seite." was={changes ? "Blau" : undefined}>
              <ColorInput value="#0f766e" swatches={["#0f766e", "#1d4ed8", "#b45309", "#8e1b6f"]} disabled={props.locked} />
            </Setting>
            <Setting name="dim" label="Hintergrund abdunkeln" hint="Damit die Schrift auf dem Foto lesbar bleibt.">
              <Slider value={0.3} min={0} max={0.8} step={0.05} format={{ style: "percent" }} disabled={props.locked} />
            </Setting>
          </Section>
        </Pane>
        {/* the side column only while it is full: who changed what */}
        <Pane side label="Verlauf" width={{ min: 280, default: 320 }}>
          <Section icon="history" title="Zuletzt geändert" more={{ label: "Protokoll", forward: true }}>
            <Digest
              label="Zuletzt geändert"
              activity={[
                {
                  person: people.ada,
                  text: (
                    <>
                      <Text weight="strong">Ada Renz</Text> hat k2b.example als Domain erlaubt
                    </>
                  ),
                  time: "gestern, 16:20",
                },
                {
                  person: people.tom,
                  text: (
                    <>
                      <Text weight="strong">Tom Oswald</Text> hat das Logo ersetzt
                    </>
                  ),
                  time: "18. Nov., 14:47",
                },
              ]}
            />
          </Section>
        </Pane>
      </Pane.Split>
    </Workspace>
  );
}

// The states that Fibel's Example offers beside the default; the recipe test renders each one as well.
export const states = {
  // nothing set yet: no tags, no logo, nothing changed
  empty: () => <SignInPageSettings empty />,
  // while a save runs, or for a person who may only read: every control takes no input
  locked: () => <SignInPageSettings locked />,
};
