import { createSignal, Show } from "solid-js";
import { Nav, Notice, NoticeStack, Pane, Row, TabBar, Text, Workspace } from "../src/v2";

// The frame of an installed app as a phone shows it (invented places): the sidebar with the brand's logo and counts,
// a tab bar of six places (four, then "More" with the other two), and a stack of floating notices over a long pane.
// `window.__hideNotices()` takes the notices away; `window.__oneLine` holds a notice of one line for the alignment.

declare global {
  interface Window {
    __hideNotices?: () => void;
    __navigated?: number;
  }
}

// Spaces is the open place, in the sheet of "More"; it opens in place, so the sheet closes over the same page.
const places = [
  { label: "Start", icon: "home", href: "#start" },
  { label: "Chat", icon: "messages", href: "#chat", unread: 3 },
  { label: "Dateien", icon: "folder", href: "#dateien" },
  { label: "Mail", icon: "mail", href: "#mail", unread: 120 },
  { label: "Notizbücher", icon: "notebook", href: "#notizbuecher", unread: 2 },
  {
    label: "Spaces",
    icon: "layout-kanban",
    href: "#spaces",
    unread: 5,
    current: true,
    onNavigate: () => {
      window.__navigated = (window.__navigated ?? 0) + 1;
    },
  },
];

const LOGO =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 20'%3E%3Crect width='40' height='20' rx='4' fill='%239a3412'/%3E%3C/svg%3E";

export function Demo() {
  const [notices, setNotices] = createSignal(true);
  if (typeof window !== "undefined") window.__hideNotices = () => setNotices(false);
  return (
    <div class="demo-frame">
      <Workspace
        sidebar={
          <Nav
            title="Lindenhof Cloud"
            icon="cloud"
            logo={LOGO}
            groups={[
              {
                label: "Apps",
                items: [
                  { label: "Chat", icon: "messages", href: "#chat", unread: 3 },
                  { label: "Spaces", icon: "layout-kanban", href: "#spaces", count: 5 },
                  { label: "Mail", icon: "mail", href: "#mail", count: 40, unread: 0 },
                ],
              },
            ]}
          />
        }
      >
        <Pane label="Start">
          <div id="one-line">
            <Notice tone="info" icon="refresh" actions={[{ label: "Neu laden", onClick: () => {} }]}>
              Neue Version von Lindenhof Cloud
            </Notice>
          </div>
          <div id="titled">
            <Notice tone="warn" title="Schlüssel läuft ab" meta="in 3 Tagen" actions={[{ label: "Verlängern", onClick: () => {} }]}>
              Danach kann der Dienst nicht mehr auf das Lager zugreifen.
            </Notice>
          </div>
          {Array.from({ length: 30 }, (_, index) => (
            <Row icon="box" lines={[`Regal ${index + 1}`, "Lager Nord"]} href="#regal" />
          ))}
          <Text type="meta">Ende der Liste</Text>
        </Pane>
      </Workspace>
      <TabBar label="App" items={places} />
      <NoticeStack>
        <Show when={notices()}>
          <Notice tone="warn" icon="wifi-off" actions={[{ label: "Ausblenden", onClick: () => setNotices(false) }]}>
            Offline – Änderungen gehen raus, sobald du wieder online bist
          </Notice>
        </Show>
      </NoticeStack>
    </div>
  );
}
