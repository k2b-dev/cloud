import { createSignal, For, Show } from "solid-js";
import { List, Nav, type NavGroup, Pane, Row, Text, Workspace } from "../src/v2";

// A messenger's sidebar (Valentin's Chat, v8): the app's name, the search and "Neuer Chat" under it, the filters as
// entries, then the conversations as the nav's own rows (`list`), which scroll on their own above "Archiv" at the foot.
// On the phone the conversations are the page while no pane is open (`phone: "page"`). Hooks on `window`:
// - `__navListOpen(i)` opens a conversation as the detail, `__navListClose()` closes it (as its way back does);
// - `__navListPage()` opens "Kanäle entdecken", a pane of its own that is no detail;
// - `__navListUnread()` raises a count and `__navListAddGroup()` puts a group before the others, as live data does:
//   the app builds its groups again, and the list keeps its rows and its scroll (`__navListMade` counts its making).

declare global {
  interface Window {
    __navListOpen?: (index: number) => void;
    __navListClose?: () => void;
    __navListPage?: () => void;
    __navListUnread?: () => void;
    __navListAddGroup?: () => void;
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
  const [page, setPage] = createSignal(false);
  const [unread, setUnread] = createSignal(3);
  const [pinnedGroup, setPinnedGroup] = createSignal(false);
  const [search, setSearch] = createSignal("");
  if (typeof window !== "undefined") {
    window.__navListOpen = (index) => setOpen(index);
    window.__navListClose = () => setOpen(undefined);
    window.__navListPage = () => setPage(true);
    window.__navListUnread = () => setUnread(unread() + 1);
    window.__navListAddGroup = () => setPinnedGroup(true);
  }
  const newChat = { label: "Neuer Chat", icon: "message-plus", onClick: () => undefined };
  // the conversations, counted each time they are made
  const Conversations = () => {
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
  };
  // a new array on every count, as an app builds its model again
  const groups = (): NavGroup[] => [
    ...(pinnedGroup() ? [{ label: "Angeheftet", items: [{ label: "Lager", icon: "pin", href: "/chat/c/lager" }] }] : []),
    {
      items: [
        { label: "Ungelesen", icon: "mail", count: unread(), href: "/chat?filter=unread" },
        { label: "Für dich", icon: "at", count: 1, href: "/chat/for-you" },
        { label: "Kanäle entdecken", icon: "speakerphone", onClick: () => setPage(true) },
      ],
    },
  ];
  return (
    <Workspace
      detail={480}
      detailEmpty={{ icon: "messages", text: "Kein Chat geöffnet" }}
      primary={open() === undefined && !page() ? newChat : undefined}
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
          groups={groups()}
          list={<Conversations />}
          phone="page"
          foot={[{ label: "Archiv", icon: "archive", href: "/chat/archive" }]}
        />
      }
    >
      <Pane.Split>
        <Show when={page()}>
          <Pane label="Kanäle entdecken" back={{ label: "Chats", onClick: () => setPage(false) }}>
            <Text>Ankündigungen, IT-Hilfe und Werkstatt-Termine</Text>
          </Pane>
        </Show>
        <Show when={open() !== undefined}>
          <Pane detail label="Chat" back={{ label: "Chats", onClick: () => setOpen(undefined) }}>
            <Text>{chats[open() ?? 0]?.name}</Text>
          </Pane>
        </Show>
      </Pane.Split>
    </Workspace>
  );
}
