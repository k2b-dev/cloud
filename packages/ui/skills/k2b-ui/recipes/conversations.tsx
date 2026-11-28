// Recipe: conversations in the sidebar (a messenger). The `Nav` holds the app's name with "Neuer Chat" as an icon
// button at its end, the search, the filters as entries, then the conversations as the app's own rows (`list`), which
// scroll on their own above the foot. The open conversation is the detail beside it: two columns, no list pane and no
// head bar of their own. On the phone the list with its search is the page (`phone: "page"`) and "Neuer Chat" floats.
import { Bar, List, Nav, Pane, RecordHead, Row, Workspace } from "@k2b/ui/v2";
import { Show } from "solid-js";

type Conversation = { id: string; name: string; line: string; time: string; unread?: number };

const conversations: Conversation[] = [
  { id: "werkstatt", name: "Werkstatt Nord", line: "Lena: Kannst du die Fotos an den Lieferanten schicken?", time: "11:53", unread: 2 },
  { id: "lieferung", name: "Lieferung KW 49", line: "Nora: Abholung Montag um 7, Rampe 3.", time: "11:57" },
  { id: "nora", name: "Nora Weber", line: "Die Rechnung listet 12 Stühle, bestellt waren 10.", time: "11:45", unread: 3 },
  { id: "lena", name: "Lena Hoffmann", line: "Danke! Dann bleibt es bei Donnerstag.", time: "11:09" },
  { id: "jonas", name: "Jonas Keller", line: "Du: Schon erledigt, sie antworten heute.", time: "10:22", unread: 1 },
  { id: "messe", name: "Messe Leipzig", line: "Du: Ist die Lieferung angekommen?", time: "08:57" },
  { id: "mira", name: "Mira Solberg", line: "Kannst du die Fotos an den Lieferanten schicken?", time: "gestern" },
  { id: "felix", name: "Felix Braun", line: "Danke, dann bleibt es beim Plan.", time: "gestern" },
  { id: "sara", name: "Sara Yilmaz", line: "Ja, um 7. Zwei Kisten sind beschädigt.", time: "Mo." },
  { id: "ada", name: "Ada Renz", line: "Du: Schon erledigt.", time: "So." },
];

const nora = "nora";
const messages = [
  { from: "Nora Weber", text: "Die Lieferung ist da, zwei Kisten sind beschädigt.", time: "11:02" },
  { from: "Robin Example", text: "Ich schicke dem Lieferanten die Fotos.", time: "11:10" },
  { from: "Nora Weber", text: "Die Rechnung listet 12 Stühle, bestellt waren 10. Ich bitte sie, das zu korrigieren.", time: "11:45" },
];
const newChat = { label: "Neuer Chat", icon: "message-plus", href: "/chat/new" };

/** The screen with one conversation open, or none (then the phone shows the list as its page). */
function Screen(props: { open?: string }) {
  return (
    <Workspace
      // a list of conversations needs more room than a few entries
      sidebarWidth={{ min: 280, default: 320 }}
      detail={480}
      detailEmpty={{ icon: "messages", text: "Kein Chat geöffnet" }}
      primary={newChat}
      sidebar={
        <Nav
          title="Chat"
          icon="messages"
          search={{ label: "Chats durchsuchen", value: "", onInput: () => undefined }}
          primary={newChat}
          groups={[
            {
              items: [
                { label: "Ungelesen", icon: "mail", count: 6, href: "/chat?filter=unread" },
                { label: "Für dich", icon: "at", count: 1, href: "/chat/for-you" },
                { label: "Kanäle entdecken", icon: "speakerphone", href: "/chat/channels" },
              ],
            },
          ]}
          list={
            <List label="Chats">
              {conversations.map((chat) => (
                <Row
                  avatar={{ name: chat.name }}
                  lines={[chat.name, chat.line]}
                  meta={chat.unread}
                  unread={chat.unread !== undefined}
                  time={chat.time}
                  current={chat.id === props.open}
                  href={`/chat/c/${chat.id}`}
                />
              ))}
            </List>
          }
          phone="page"
          foot={[{ label: "Archiv", icon: "archive", href: "/chat/archive" }]}
        />
      }
    >
      <Pane.Split>
        <Show when={props.open}>
          <Pane
            detail
            label="Nora Weber"
            back={{ label: "Chats", href: "/chat" }}
            head={<Bar start={<RecordHead name="Nora Weber" avatar={{ name: "Nora Weber" }} ids={[{ value: "Einkauf" }]} />} />}
          >
            {/* the conversation itself is the app's own drawing; here its messages as rows */}
            <List label="Nachrichten">
              {messages.map((message) => (
                <Row avatar={{ name: message.from }} lines={[message.from, message.text]} time={message.time} />
              ))}
            </List>
          </Pane>
        </Show>
      </Pane.Split>
    </Workspace>
  );
}

export default function Conversations() {
  return <Screen open={nora} />;
}

export const states = {
  // nothing open: on the phone the list with its search is the page, and "Neuer Chat" floats
  list: () => <Screen />,
};
