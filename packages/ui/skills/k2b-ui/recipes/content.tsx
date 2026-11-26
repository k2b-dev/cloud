// Recipe: a page to read. The text in Prose (Markdown, rendered safely), a token to copy in Facts mono, the files as
// Tiles, and a drawing of its own in a Canvas inside its Section. What has no v2 primitive yet is a k2b-ui gap.
// Empty, loading and failed stand where the text would stand; the head with its deeds stays (see `states` at the end).
import {
  Avatar,
  Band,
  Bar,
  Button,
  Canvas,
  Empty,
  Facts,
  Failed,
  Inline,
  Loading,
  Mark,
  Nav,
  Pane,
  Prose,
  Section,
  Text,
  Tiles,
  Workspace,
} from "@k2b/ui/v2";

// The app this screen belongs to: its colour tints the page and marks it in the host's rail.
export const app = { name: "Handbuch", color: "#7c3aed", icon: "notebook" };

const page = { icon: "file-text", color: "#7c3aed" };
const people = [{ name: "Ada Renz" }, { name: "Lena Hartwig" }, { name: "Felix Thal" }];

const guide = `## Was wir annehmen

Möbel, Kunst und Schmuck aus Nachlässen und Haushalten. Jedes Stück bekommt bei der Annahme eine **Einliefernummer**
und ein Foto.

- Möbel nur nach Termin, sonst in den Hof.
- Schmuck geht am selben Tag in den Tresor.
- Was wir nicht verkaufen können, holt die Einlieferin binnen 14 Tagen ab.

Fragen zur Annahme beantwortet [die Annahme](mailto:annahme@werkstatt.example).`;

type Props = { text?: string; loading?: boolean; failed?: boolean };

export default function IntakeGuide(props: Props) {
  const text = () => props.text ?? guide;
  return (
    <Workspace
      sidebar={
        <Nav
          title="Handbuch"
          icon="notebook"
          groups={[
            {
              items: [
                { label: "Start", icon: "home", href: "#start" },
                { label: "Zuletzt geändert", icon: "clock", count: 4, href: "#zuletzt" },
              ],
            },
            {
              label: "Bereiche",
              items: [
                { label: "Annahme", icon: "package-import", color: "#7c3aed", current: true },
                { label: "Werkstatt", icon: "tool", color: "#c2410c", href: "#werkstatt" },
                { label: "Versand", icon: "truck", color: "#0e7490", href: "#versand" },
                { label: "Büro", icon: "briefcase", color: "#2563eb", href: "#buero" },
              ],
            },
          ]}
        />
      }
      head={
        <Bar
          start={
            <Inline>
              <Mark {...page} />
              <Text type="lead">Leitfaden Annahme</Text>
            </Inline>
          }
          end={
            <>
              <Button variant="ghost" icon="share" label="Teilen" />
              <Button variant="primary" icon="pencil">
                Bearbeiten
              </Button>
            </>
          }
        />
      }
      primary={{ label: "Bearbeiten", icon: "pencil" }}
    >
      <Pane
        label="Leitfaden Annahme"
        status={
          <Bar
            start={
              <Inline>
                <Avatar.Stack people={people} label="Ada Renz, Lena Hartwig und Felix Thal schreiben mit" />
                <Text type="meta">Ada Renz hat ihn vor 2 Tagen geändert · 3 schreiben mit</Text>
              </Inline>
            }
          />
        }
      >
        {props.failed ? (
          <Failed text="Der Leitfaden konnte nicht geladen werden. Es wurde nichts geändert." onRetry={() => location.reload()} />
        ) : props.loading ? (
          // as many rows as the text usually has lines, so nothing moves when it comes
          <Loading rows={6} />
        ) : !text() ? (
          <Empty icon="file-text" text="Dieser Leitfaden hat noch keinen Text." action={{ label: "Text schreiben", icon: "pencil" }} />
        ) : (
          <>
            <Band>
              {/* k2b-ui gap: writing Markdown in place (the editor of @k2b/editor) has no v2 form yet; "Bearbeiten" opens it. */}
              <Prose markdown={text()} />
            </Band>
            <Section icon="key" title="Zugang für die Waage">
              {/* k2b-ui gap: no code block with highlighting in v2; a value to copy is a Facts item with mono and copy. */}
              <Facts
                items={[{ label: "Geräte-Schlüssel", value: "wf_scale_7Q2K-94RT-XM3D", mono: true, copy: "wf_scale_7Q2K-94RT-XM3D" }]}
              />
            </Section>
            <Section icon="paperclip" title="Anhänge" count={3}>
              {/* k2b-ui gap: no image or video viewer in v2; media are tiles that open the file. */}
              <Tiles
                label="Anhänge"
                items={[
                  { icon: "file-type-pdf", color: "#dc2626", title: "Annahmeschein.pdf", meta: "84 KB", href: "#annahmeschein" },
                  { icon: "photo", color: "#0e7490", title: "Hof-Plan.jpg", meta: "1,2 MB", href: "#hof-plan" },
                  { icon: "video", color: "#7c3aed", title: "Tresor-Ablauf.mp4", meta: "38 MB", href: "#tresor" },
                ]}
              />
            </Section>
            <Section icon="map" title="Hof-Plan" summary="Möbel kommen über Tor 2 in Halle B.">
              {/* A drawing of its own (a plan, a map, a chart of @k2b/ui) stands in a Canvas; inside it, CSS is free. */}
              <Canvas label="Plan des Hofs: Einfahrt über Tor 2, Halle B für Möbel, Tresor in Halle A" height={240}>
                <svg viewBox="0 0 720 240" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" style={{ display: "block" }}>
                  {/* the yard, the street and the way in */}
                  <rect x="0" y="0" width="720" height="240" style={{ fill: "var(--k2-n50)" }} />
                  <rect x="0" y="200" width="720" height="40" style={{ fill: "var(--k2-n200)" }} />
                  <text x="16" y="224" style={{ font: "var(--k2-t-meta)", fill: "var(--k2-subtle)" }}>
                    Lindenallee
                  </text>
                  <path
                    d="M520 200 V150 H430"
                    style={{ fill: "none", stroke: "var(--k2-app)", "stroke-width": "3", "stroke-dasharray": "6 6" }}
                  />
                  <path d="M436 144 L428 150 L436 156" style={{ fill: "none", stroke: "var(--k2-app)", "stroke-width": "3" }} />
                  {/* Halle A with the safe */}
                  <rect x="40" y="24" width="220" height="150" rx="6" style={{ fill: "var(--k2-surface)", stroke: "var(--k2-n300)" }} />
                  <text x="56" y="48" style={{ font: "var(--k2-t-row)", "font-weight": "600", fill: "var(--k2-text)" }}>
                    Halle A
                  </text>
                  <text x="56" y="66" style={{ font: "var(--k2-t-meta)", fill: "var(--k2-subtle)" }}>
                    Kunst, Schmuck
                  </text>
                  <rect
                    x="180"
                    y="110"
                    width="64"
                    height="48"
                    rx="4"
                    style={{ fill: "color-mix(in srgb, #ca8a04 18%, var(--k2-surface))", stroke: "#ca8a04" }}
                  />
                  <text x="212" y="139" text-anchor="middle" style={{ font: "var(--k2-t-meta)", "font-weight": "600", fill: "#854d0e" }}>
                    Tresor
                  </text>
                  {/* Halle B for furniture, reached through gate 2 */}
                  <rect x="300" y="24" width="250" height="110" rx="6" style={{ fill: "var(--k2-app-tint)", stroke: "var(--k2-app)" }} />
                  <text x="316" y="48" style={{ font: "var(--k2-t-row)", "font-weight": "600", fill: "var(--k2-app-text)" }}>
                    Halle B · Möbel
                  </text>
                  <text x="316" y="66" style={{ font: "var(--k2-t-meta)", fill: "var(--k2-app-text)" }}>
                    Anlieferung nur nach Termin
                  </text>
                  <rect x="410" y="130" width="40" height="8" style={{ fill: "var(--k2-app)" }} />
                  <text x="456" y="138" style={{ font: "var(--k2-t-meta)", "font-weight": "600", fill: "var(--k2-app-text)" }}>
                    Tor 2
                  </text>
                  {/* parking for vans */}
                  <rect
                    x="590"
                    y="24"
                    width="100"
                    height="150"
                    rx="6"
                    style={{ fill: "none", stroke: "var(--k2-n300)", "stroke-dasharray": "4 4" }}
                  />
                  <text x="640" y="104" text-anchor="middle" style={{ font: "var(--k2-t-meta)", fill: "var(--k2-subtle)" }}>
                    Transporter
                  </text>
                  <rect x="60" y="174" width="40" height="8" style={{ fill: "var(--k2-n400)" }} />
                  <text x="106" y="182" style={{ font: "var(--k2-t-meta)", fill: "var(--k2-subtle)" }}>
                    Tor 1
                  </text>
                </svg>
              </Canvas>
            </Section>
          </>
        )}
      </Pane>
    </Workspace>
  );
}

// The states Fibel's Example offers beside the default; the recipe test renders each one as well.
export const states = {
  empty: () => <IntakeGuide text="" />,
  loading: () => <IntakeGuide loading />,
  failed: () => <IntakeGuide failed />,
};
