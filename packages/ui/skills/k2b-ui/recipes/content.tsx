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
export const app = { color: "#7c3aed", icon: "notebook" };

const page = { icon: "file-text", color: "#7c3aed" };
const people = [{ name: "Ada Renz" }, { name: "Lena Hartwig" }, { name: "Felix Thal" }];

const guide = `## Was wir annehmen

Möbel, Kunst und Schmuck aus Nachlässen und Haushalten. Jedes Stück bekommt bei der Annahme eine **Einliefernummer**
und ein Foto.

- Möbel nur nach Termin, sonst in den Hof.
- Schmuck geht am selben Tag in den Tresor.
- Was wir nicht verkaufen können, holt die Einlieferin binnen 14 Tagen ab.

Fragen zur Annahme beantwortet [die Annahme](mailto:annahme@example.de).`;

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
              <Canvas label="Plan des Hofs mit Tor 2 und Halle B" height={160}>
                <svg viewBox="0 0 400 160" width="100%" height="100%" style={{ display: "block" }} role="img" aria-label="Plan des Hofs">
                  <rect x="20" y="20" width="160" height="120" style={{ fill: "var(--k2-n100)" }} />
                  <rect x="220" y="20" width="160" height="120" style={{ fill: "var(--k2-app-tint)" }} />
                  <text x="100" y="84" text-anchor="middle" style={{ font: "var(--k2-t-meta)", fill: "var(--k2-subtle)" }}>
                    Halle A
                  </text>
                  <text x="300" y="84" text-anchor="middle" style={{ font: "var(--k2-t-meta)", fill: "var(--k2-app-text)" }}>
                    Halle B · Tor 2
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
