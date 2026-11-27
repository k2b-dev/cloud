import { render } from "solid-js/web";
import { List, Pane, Row, type RowProps, Workspace } from "../src/v2";

// The outline of a note ("Inhalt"): its headings as a flat list, each row at the level of its heading, the open one
// current. Nothing folds; a deeper heading only stands further in. The sixth level carries a long title.

declare global {
  interface Window {
    __k2Mounted?: boolean;
  }
}

const headings: { title: string; level: NonNullable<RowProps["level"]> }[] = [
  { title: "Werkstattordnung", level: 1 },
  { title: "Öffnungszeiten", level: 2 },
  { title: "Feiertage", level: 3 },
  { title: "Brückentage im Mai", level: 4 },
  { title: "Notdienst", level: 5 },
  { title: "Rufbereitschaft am Wochenende mit Übergabe an die Nachbarwerkstatt in der Lindenstraße", level: 6 },
  { title: "Sicherheit", level: 2 },
];

const root = document.getElementById("root");
if (!root) throw new Error("row level: #root is missing");
render(
  () => (
    <Workspace>
      <Pane label="Inhalt">
        <List label="Inhalt">
          {headings.map((heading) => (
            <Row lines={[heading.title]} level={heading.level} href={`#${heading.title}`} current={heading.title === "Feiertage"} />
          ))}
        </List>
        {/* a row without a level stands at the edge, as before */}
        <List label="Ohne Ebene">
          <Row lines={["Ohne Ebene"]} />
        </List>
      </Pane>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
