// Recipe: files to send. A tool turns a document into Markdown: the field is where the document is dropped or chosen
// (`FileInput`, its files held in a signal by `value` and `onChange`), the head's one primary "Umwandeln" waits for a
// document, the last conversions are a list with the type of each file, what came of it, its state and when, and a
// side column says what the tool takes, how the week went and what it cannot read. The form state lives in the app;
// the primitives only show it.
import { Bar, Button, Chip, Facts, Field, FileInput, List, Nav, Pane, Row, Section, StatusRow, Text, Workspace } from "@k2b/ui/v2";
import { createSignal } from "solid-js";

type State = "ok" | "warn" | "bad";
type Done = { id: string; name: string; icon: string; size: string; result: string; state: State; when: string };

// each state in colour, symbol and word, never a colour alone
const stateMark: Record<State, { icon: string; word: string }> = {
  ok: { icon: "check", word: "Fertig" },
  warn: { icon: "alert-triangle", word: "Mit Hinweis" },
  bad: { icon: "x", word: "Fehlgeschlagen" },
};

const recent: Done[] = [
  {
    id: "d1",
    name: "Angebot Einbauschrank Flur.pdf",
    icon: "file-type-pdf",
    size: "1,2 MB",
    result: "4 Seiten, 2 Tabellen",
    state: "ok",
    when: "vor 12 Min.",
  },
  {
    id: "d2",
    name: "Wartungsvertrag Stadtwerke.docx",
    icon: "file-type-doc",
    size: "86 kB",
    result: "9 Seiten, 14 Abschnitte",
    state: "ok",
    when: "09:14",
  },
  {
    id: "d3",
    name: "Protokoll Baubesprechung KW 47.pdf",
    icon: "file-type-pdf",
    size: "640 kB",
    result: "3 Seiten, 1 Bild nicht lesbar",
    state: "warn",
    when: "gestern",
  },
  {
    id: "d4",
    name: "Preisliste Beschläge 2027.xlsx",
    icon: "file-type-xls",
    size: "212 kB",
    result: "2 Tabellen, 418 Zeilen",
    state: "ok",
    when: "Mo.",
  },
  {
    id: "d5",
    name: "Aufmaß Küche Oswald.pdf",
    icon: "file-type-pdf",
    size: "2,4 MB",
    result: "6 Seiten, 3 Skizzen verlinkt",
    state: "ok",
    when: "Mo.",
  },
  {
    id: "d6",
    name: "Leitfaden Annahme.md",
    icon: "file-text",
    size: "12 kB",
    result: "unverändert, Links geprüft",
    state: "ok",
    when: "Fr.",
  },
  {
    id: "d7",
    name: "Lieferschein Scan.pdf",
    icon: "file-type-pdf",
    size: "3,1 MB",
    result: "ein Scan ohne Text",
    state: "bad",
    when: "Fr.",
  },
  {
    id: "d8",
    name: "Schulung Stapler.docx",
    icon: "file-type-doc",
    size: "1,1 MB",
    result: "11 Seiten, 7 Bilder verlinkt",
    state: "ok",
    when: "18. Nov.",
  },
];

// a stand-in for a picked document of a usual size (1,8 MB), so the recipe draws with a chosen file without a pick
const waiting = () => [new File([new Uint8Array(1_800_000)], "Aufmaß Bad Oswald.pdf", { type: "application/pdf" })];

type Props = { chosen?: readonly File[] };

export default function DocumentToMarkdown(props: Props) {
  // the chosen document is the page's state: the field shows it, "Umwandeln" waits for it
  const [files, setFiles] = createSignal<readonly File[]>(props.chosen ?? waiting());
  const ready = () => files().length > 0;
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
                { label: "Dokument zu Markdown", icon: "markdown", current: true, count: 8 },
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
      primary={{ label: "Umwandeln", icon: "arrow-right", disabled: !ready() }}
      head={
        <Bar
          start={<Text type="body">Dokument zu Markdown</Text>}
          end={
            <Button variant="primary" icon="arrow-right" disabled={!ready()}>
              Umwandeln
            </Button>
          }
        />
      }
    >
      <Pane.Split>
        <Pane
          label="Dokument zu Markdown"
          status={
            <StatusRow
              lead="8 Dokumente diese Woche"
              facts={[
                { value: "1", after: "fehlgeschlagen" },
                { before: "zuletzt", value: "vor 12 Min." },
              ]}
            />
          }
        >
          <Section icon="file-upload" title="Dokument">
            <Field name="document" label="PDF, Word oder Markdown" hint="Bis 20 MB. Das Dokument bleibt nur für die Umwandlung hier.">
              <FileInput accept=".pdf,.docx,.md" maxSize={20 * 1000 * 1000} value={files()} onChange={setFiles} />
            </Field>
          </Section>
          <Section icon="history" title="Zuletzt umgewandelt" count={recent.length}>
            <List label="Zuletzt umgewandelt">
              {recent.map((done) => (
                <Row
                  icon={done.icon}
                  lines={[done.name, done.result]}
                  meta={done.size}
                  time={done.when}
                  marks={
                    <Chip status={done.state} icon={stateMark[done.state].icon}>
                      {stateMark[done.state].word}
                    </Chip>
                  }
                  href={`#${done.id}`}
                />
              ))}
            </List>
          </Section>
        </Pane>
        <Pane side label="So wird umgewandelt" width={{ min: 260, default: 320 }}>
          <Section icon="info-circle" title="So wird umgewandelt">
            <Facts
              items={[
                { label: "Formate", value: "PDF, Word (.docx), Markdown" },
                { label: "Größe", value: "bis 20 MB je Dokument" },
                { label: "Tabellen", value: "bleiben Tabellen" },
                { label: "Bilder", value: "werden als Link gesetzt" },
                { label: "Aufbewahrung", value: "nur während der Umwandlung" },
              ]}
            />
          </Section>
          <Section icon="chart-bar" title="Diese Woche">
            <Facts
              items={[
                { label: "Umgewandelt", value: "8 Dokumente, 41 Seiten" },
                { label: "Mit Hinweis", value: "1, ein Bild nicht lesbar" },
                { label: "Fehlgeschlagen", value: "1, ein Scan ohne Text" },
              ]}
            />
          </Section>
          <Section icon="alert-circle" title="Was nicht geht">
            <Facts
              items={[
                { label: "Scans", value: "Text in Bildern wird nicht gelesen" },
                { label: "Passwort", value: "geschützte Dateien erst entsperren" },
                { label: "Makros", value: "werden nicht übernommen" },
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
  // nothing chosen yet: "Umwandeln" waits for a document
  empty: () => <DocumentToMarkdown chosen={[]} />,
};
