// Recipe: files to send. A tool turns a document into Markdown: the field is where the document is dropped or chosen
// (`FileInput`), the chosen file stands under it with its type and size, and the last conversions are a list with the
// type of each file, its size and when it was made. The form state lives in the app; the primitives only show it.
import { Bar, Button, Chip, Field, FileInput, List, Nav, Pane, Row, Section, StatusRow, Text, Workspace } from "@k2b/ui/v2";

type Done = { id: string; name: string; icon: string; size: string; pages: string; when: string };

const recent: Done[] = [
  { id: "d1", name: "Angebot Einbauschrank Flur.pdf", icon: "file-type-pdf", size: "1,2 MB", pages: "4 Seiten", when: "vor 12 Min." },
  { id: "d2", name: "Wartungsvertrag Stadtwerke.docx", icon: "file-type-doc", size: "86 KB", pages: "9 Seiten", when: "heute, 09:14" },
  { id: "d3", name: "Protokoll Baubesprechung KW 47.pdf", icon: "file-type-pdf", size: "640 KB", pages: "3 Seiten", when: "gestern" },
  { id: "d4", name: "Preisliste Beschläge 2027.xlsx", icon: "file-type-xls", size: "212 KB", pages: "2 Tabellen", when: "Mo. 23. Nov." },
];

// the document waiting for "Umwandeln" (a stand-in file, so the recipe draws without a pick)
const waiting = [new File(["%PDF-1.7"], "Aufmass Küche Oswald.pdf", { type: "application/pdf" })];

type Props = { chosen?: readonly File[] };

export default function DocumentToMarkdown(props: Props) {
  const chosen = props.chosen ?? waiting;
  return (
    <Workspace
      sidebar={
        <Nav
          title="Werkzeuge"
          icon="tools"
          groups={[
            {
              label: "Dokumente",
              items: [
                { label: "Dokument zu Markdown", icon: "markdown", current: true },
                { label: "PDF zusammenfügen", icon: "files" },
                { label: "Text vergleichen", icon: "git-compare" },
              ],
            },
            {
              label: "Daten",
              items: [
                { label: "CSV prüfen", icon: "table" },
                { label: "QR-Code", icon: "qrcode" },
              ],
            },
          ]}
        />
      }
      head={<Bar start={<Text type="body">Dokument zu Markdown</Text>} />}
    >
      <Pane
        label="Dokument zu Markdown"
        status={<StatusRow lead="4 Dokumente diese Woche" facts={[{ before: "zuletzt", value: "vor 12 Min." }]} />}
      >
        <Section icon="file-upload" title="Dokument">
          <Field name="document" label="PDF, Word oder Markdown" hint="Bis 20 MB. Das Dokument bleibt nur für die Umwandlung hier.">
            <FileInput accept=".pdf,.docx,.md" maxSize={20 * 1024 * 1024} value={chosen} />
          </Field>
          <Bar
            end={
              <Button variant="primary" icon="arrow-right" disabled={!chosen.length}>
                Umwandeln
              </Button>
            }
          />
        </Section>
        <Section icon="history" title="Zuletzt umgewandelt" count={recent.length}>
          <List label="Zuletzt umgewandelt">
            {recent.map((done) => (
              <Row
                icon={done.icon}
                lines={[done.name, `${done.size} · ${done.pages}`]}
                time={done.when}
                end={<Chip status="ok">Fertig</Chip>}
                href={`#${done.id}`}
              />
            ))}
          </List>
        </Section>
      </Pane>
    </Workspace>
  );
}

// The states that Fibel's Example offers beside the default; the recipe test renders each one as well.
export const states = {
  // nothing chosen yet: "Umwandeln" waits for a document
  empty: () => <DocumentToMarkdown chosen={[]} />,
};
