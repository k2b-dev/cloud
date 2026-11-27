import { createSignal, For, Show } from "solid-js";
import { List, Nav, Pane, Row, Text, Workspace } from "../src/v2";

// A messenger's sidebar (Valentin's Chat, v8): the app's name, the search and "Neuer Chat" under it, the filters as
// entries, then the conversations as the app's own rows, which scroll on their own above "Archiv" at the foot. On the
// phone the conversations are the page while none is open (`phone: "page"`). `window.__navListOpen(i)` opens one as the
// detail, `window.__navListClose()` closes it; `window.__navListUnread()` raises a count, as live messages do: the app builds its
// groups again, and the list keeps its rows and its scroll.

declare global {
  interface Window {
    __navListOpen?: (index: number) => void;
    __navListClose?: () => void;
    __navListUnread?: () => void;
    __navListMade?: number;
    __navListSearch?: string;
  }
}

const names = ["Werkstatt Nord", "Lieferung KW 49", "Nora Weber", "Messe Leipzig", "Lena Hoffmann", "Jonas Keller", "Mira Solberg"];
const chats = Array.from({ length: 40 }, (_, index) => ({
  id: `c${index}`,
  name: `${names[index % names.length]}${index >= names.length ? ` ${Math.floor(index / names.length) + 1}` : ""}`,
  line: index % 3 === 0 ? "Lena: Kannst du die Fotos an den Lieferanten schicken?" : "Du: Ja, um 7. Zwei Kisten sind beschädigt.",
  time: `${String(11 - (index % 10)).padStart(2, "0")}:${String((index * 7) % 60).padStart(2, "0")}`,
}));

export function Demo() {
  const [open, setOpen] = createSignal<number>();
  const [unread, setUnread] = createSignal(3);
  const [search, setSearch] = createSignal("");
  if (typeof window !== "undefined") {
    window.__navListOpen = (index) => setOpen(index);
    window.__navListClose = () => setOpen(undefined);
    window.__navListUnread = () => setUnread(unread() + 1);
  }
  const newChat = { label: "Neuer Chat", icon: "message-plus", onClick: () => undefined };
  return (
    <Workspace
      detail={480}
      detailEmpty={{ icon: "messages", text: "Kein Chat geöffnet" }}
      primary={open() === undefined ? newChat : undefined}
      sidebar={
        <Nav
          title="Chat"
          icon="messages"
          search={{
            label: "Chats durchsuchen",
            value: search(),
            onInput: (value) => {
              setSearch(value);
              if (typeof window !== "undefined") window.__navListSearch = value;
            },
          }}
          primary={newChat}
          // a new array on every count, as an app builds its model again
          groups={[
            {
              items: [
                { label: "Ungelesen", icon: "mail", count: unread(), href: "/chat?filter=unread" },
                { label: "Für dich", icon: "at", count: 1, href: "/chat/for-you" },
                { label: "Kanäle entdecken", icon: "speakerphone", href: "/chat/channels" },
              ],
            },
            {
              phone: "page",
              list: () => {
                if (typeof window !== "undefined") window.__navListMade = (window.__navListMade ?? 0) + 1;
                return (
                  <List label="Chats">
                    <For each={chats}>
                      {(chat, index) => (
                        <Row
                          avatar={{ name: chat.name }}
                          lines={[chat.name, chat.line]}
                          time={chat.time}
                          current={open() === index()}
                          unread={index() < 2}
                          onOpen={() => setOpen(index())}
                        />
                      )}
                    </For>
                  </List>
                );
              },
            },
          ]}
          foot={[{ label: "Archiv", icon: "archive", href: "/chat/archive" }]}
        />
      }
    >
      <Pane.Split>
        <Show when={open() !== undefined}>
          <Pane detail label="Chat" back={{ label: "Chats", onClick: () => setOpen(undefined) }}>
            <Text>{chats[open() ?? 0]?.name}</Text>
          </Pane>
        </Show>
      </Pane.Split>
    </Workspace>
  );
}
