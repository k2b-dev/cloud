import { render } from "solid-js/web";
import { List, Pane, Prose, Row, Section, Workspace } from "../src/v2";

// The ways to start of a notebooks page (W2): a short list in a wide pane. With `measure` the section's head, its
// sentence and its rows stay together at the reading measure; the section's line still reaches the column's edges. A
// section without it, and a reading text, stand beside it for comparison.

declare global {
  interface Window {
    __k2Mounted?: boolean;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("section measure: #root is missing");
render(
  () => (
    <Workspace>
      <Pane label="Notizbücher">
        <Section
          title="Erstes Notizbuch"
          summary="Ein Notizbuch hält Notizen, die zusammengehören."
          measure
          actions={[{ label: "Vorlagen", onClick: () => undefined }]}
        >
          <List label="Wege zum Start">
            <Row
              lines={["Leeres Notizbuch", "Mit einer ersten Notiz"]}
              icon="notebook"
              action={{ label: "Anlegen", onClick: () => undefined }}
            />
            <Row lines={["Aus einer Vorlage", "Besprechung, Projekt, Tagebuch"]} icon="template" />
          </List>
        </Section>
        <Section title="Zuletzt geöffnet">
          <List label="Zuletzt geöffnet">
            <Row lines={["Werkstatt"]} icon="notebook" />
          </List>
        </Section>
        <Prose>
          <p>Notizbücher teilen Sie wie Ordner. Eine Notiz kann in mehreren Notizbüchern stehen, ohne doppelt zu sein.</p>
        </Prose>
      </Pane>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
