// Recipe: a list with a reader (mail). Three-line rows on the left; the reader shows the thread: a bar with its state,
// an AI summary, one Band per message with the sender row, the text in Prose and the attachments as Tiles.
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
  },
  {
    id: "t3",
    from: "Mira Solberg",
    subject: "Re: Rechnung 4471",
    preview: "Danke, ist angekommen. Ich gebe sie heute frei.",
    at: "gestern",
  },
];
const open = threads[0]!;

export default function MailScreen() {
  return (
    <Workspace
      sidebar={
        <Nav
          title="Mail"
          icon="mail"
          groups={[
            {
              label: "Postfächer",
              items: [
                { label: "Posteingang", icon: "inbox", current: true, count: 7 },
                { label: "Lieferanten", icon: "folder", nested: true },
                { label: "Gesendet", icon: "send" },
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
                unread={thread.unread}
                selected={thread.id === open.id}
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
        >
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
            <Prose html="<p>Guten Tag Frau Solberg,</p><p>die 14 Platten können wir in KW 49 liefern. Bitte bestätigen Sie bis Freitag.</p><p>Viele Grüße<br>Jonas Brandt</p>" />
            <Tiles items={[{ icon: "file-type-pdf", title: "Angebot-4471.pdf", meta: "212 KB" }]} more={{ label: "Alle herunterladen" }} />
          </Band>
        </Pane>
      </Pane.Split>
    </Workspace>
  );
}
