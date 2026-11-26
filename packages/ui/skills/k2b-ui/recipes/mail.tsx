// Recipe: a list with a reader (mail). Three-line rows on the left, each with the sender's face; the reader shows the
// thread: a bar with its state, an AI summary, one Band per message with the sender row, the text in Prose and the
// attachments as Tiles with the mark of their type.
import {
  Avatar,
  Band,
  Bar,
  Button,
  Chip,
  Icon,
  Inline,
  List,
  Nav,
  Notice,
  Pane,
  Prose,
  Row,
  StatusRow,
  Tabs,
  Text,
  Tiles,
  Workspace,
} from "@k2b/ui/v2";

type Thread = {
  id: string;
  from: string;
  subject: string;
  preview: string;
  at: string;
  unread?: boolean;
  count?: number;
  tag?: string;
  files?: boolean;
};

// Every sender has a face: a picture, or initials on the colour of their name.
const threads: Thread[] = [
  {
    id: "t1",
    from: "Holzwerk Brandt",
    subject: "Angebot Eichenplatten – Liefertermin",
    preview: "Guten Tag Frau Solberg, die Platten können wir in KW 49 liefern …",
    at: "09:42",
    unread: true,
    count: 3,
    tag: "Angebot",
    files: true,
  },
  {
    id: "t2",
    from: "Spedition Kraus",
    subject: "Abholung Montag",
    preview: "Wir holen die Paletten am Montag zwischen 8 und 10 Uhr ab.",
    at: "08:15",
    unread: true,
  },
  {
    id: "t3",
    from: "Praxis Dr. Lindqvist",
    subject: "Küche: Termin für das Aufmaß",
    preview: "Passt Ihnen Donnerstag, 14 Uhr? Die Praxis ist dann schon zu.",
    at: "07:58",
    unread: true,
    tag: "Auftrag",
  },
  {
    id: "t4",
    from: "Mira Solberg",
    subject: "Re: Rechnung 4471",
    preview: "Danke, ist angekommen. Ich gebe sie heute frei.",
    at: "gestern",
    count: 2,
  },
  {
    id: "t5",
    from: "Lackfabrik Nordhaus",
    subject: "Lieferschein 88213",
    preview: "Anbei der Lieferschein zu Ihrer Bestellung vom 19. November.",
    at: "gestern",
    files: true,
  },
  {
    id: "t6",
    from: "Felix Thal",
    subject: "Fotos Baustelle Oswald",
    preview: "Hier die Fotos vom Bad, die Fliesen sind gestern gekommen.",
    at: "Mo.",
    files: true,
  },
  {
    id: "t7",
    from: "Stadtwerke Auental",
    subject: "Abschlag Dezember",
    preview: "Ihr Abschlag für Dezember beträgt 412,00 € und wird am 1. abgebucht.",
    at: "Mo.",
  },
  {
    id: "t8",
    from: "Architekturbüro Winter",
    subject: "Treppe: geänderte Maße",
    preview: "Die Stufenhöhe ändert sich auf 17,5 cm, Plan im Anhang.",
    at: "So.",
    tag: "Auftrag",
    files: true,
  },
];
const open = threads[0]!;

// The app this screen belongs to: its colour tints the page and marks it in the host's rail.
export const app = { color: "#0f766e", icon: "mail" };

export default function MailScreen() {
  return (
    <Workspace
      // a detail opens beside the list: the sidebar keeps room for it, and its place says so while none is open
      detail
      detailEmpty={{ icon: "mail", text: "Keine Nachricht ausgewählt" }}
      sidebar={
        <Nav
          title="Mail"
          icon="mail"
          groups={[
            {
              label: "Postfächer",
              items: [
                { label: "Posteingang", icon: "inbox", current: true, count: 7 },
                { label: "Lieferanten", icon: "folder", color: "#c2410c", nested: true, count: 2, href: "#lieferanten" },
                { label: "Aufträge", icon: "folder", color: "#2563eb", nested: true, href: "#auftraege" },
                { label: "Gesendet", icon: "send", href: "#gesendet" },
              ],
            },
            {
              label: "Geteilt",
              items: [
                { label: "info@werkstatt.de", icon: "building-store", color: "#0f766e", count: 4, href: "#info" },
                { label: "rechnung@werkstatt.de", icon: "receipt", color: "#8e1b6f", href: "#rechnung" },
              ],
            },
          ]}
        />
      }
      head={
        <Bar
          start={
            <Tabs
              label="Ansichten"
              items={[
                { label: "Alle", count: 42, current: true },
                { label: "Handlungsbedarf", count: 5 },
              ]}
            />
          }
          end={
            <Button variant="primary" icon="pencil">
              Neue Nachricht
            </Button>
          }
        />
      }
      primary={{ label: "Neue Nachricht", icon: "pencil" }}
    >
      <Pane.Split>
        <Pane
          label="Nachrichten"
          width={{ min: 320, default: 432 }}
          status={
            <StatusRow
              select={{ label: "Alle auswählen" }}
              lead="7 ungelesen"
              facts={[{ before: "Heute", value: 12, after: "erledigt" }]}
            />
          }
        >
          <List label="Nachrichten">
            {threads.map((thread) => (
              <Row
                avatar={{ name: thread.from }}
                unread={thread.unread}
                current={thread.id === open.id}
                lines={[thread.from, thread.subject, thread.preview]}
                meta={thread.count}
                time={thread.at}
                href={`#${thread.id}`}
                marks={
                  <>
                    {thread.tag && (
                      <Chip tag color="#0f766e">
                        {thread.tag}
                      </Chip>
                    )}
                    {thread.files && <Icon name="paperclip" label="Anhang" />}
                  </>
                }
              />
            ))}
          </List>
        </Pane>
        <Pane
          detail
          label="Nachricht"
          head={
            <Bar
              start={<Text type="lead">{open.subject}</Text>}
              end={
                <>
                  <Button icon="check">Erledigt</Button>
                  <Button variant="ghost" icon="archive" label="Archivieren" />
                  <Button variant="ghost" icon="dots" label="Weitere Aktionen" />
                </>
              }
            />
          }
          status={
            <Bar
              start={
                <Inline>
                  <Text type="meta">3 Nachrichten</Text>
                  <Chip status="warn">Wartet auf Antwort</Chip>
                  <Chip tag color="#0f766e">
                    Angebot
                  </Chip>
                </Inline>
              }
              end={<Avatar name="Ada Renz" color="#be123c" />}
            />
          }
        >
          <Notice tone="ai" title="Kurz gesagt" actions={[{ label: "Bearbeiten" }]}>
            Brandt liefert 14 Eichenplatten in KW 49 und braucht bis Freitag eine Bestätigung.
          </Notice>
          <Band>
            <Row
              avatar={{ name: "Holzwerk Brandt", color: "#57534e" }}
              strong
              lines={["Holzwerk Brandt", "an Mira Solberg · heute, 09:42"]}
              end={
                <>
                  <Button variant="ghost" icon="arrow-back-up" label="Antworten" />
                  <Button variant="ghost" icon="dots" label="Weitere Aktionen" />
                </>
              }
            />
            <Prose
              markdown={
                "Guten Tag Frau Solberg,\n\ndie 14 Platten können wir in KW 49 liefern. Bitte bestätigen Sie bis Freitag.\n\nViele Grüße  \nJonas Brandt"
              }
            />
            <Tiles
              items={[
                { icon: "file-type-pdf", color: "#dc2626", title: "Angebot-4471.pdf", meta: "212 KB" },
                { icon: "photo", color: "#0e7490", title: "Muster-Eiche.jpg", meta: "1,8 MB" },
              ]}
              more={{ label: "Alle herunterladen" }}
            />
          </Band>
          <Band>
            <Row
              avatar={{ name: "Mira Solberg" }}
              strong
              lines={["Mira Solberg", "an Holzwerk Brandt · gestern, 16:10"]}
              end={<Button variant="ghost" icon="dots" label="Weitere Aktionen" />}
            />
            <Prose
              markdown={
                "Hallo Herr Brandt,\n\nwir brauchen 14 Platten Eiche, 28 mm, für die Küche Lindqvist. Geht das bis Mitte Dezember?\n\nGruß  \nMira Solberg"
              }
            />
          </Band>
        </Pane>
      </Pane.Split>
    </Workspace>
  );
}
