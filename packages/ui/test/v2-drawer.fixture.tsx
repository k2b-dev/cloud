import { createSignal, Show } from "solid-js";
import { LocaleProvider } from "../src/intl/locale";
import { Bar, Button, Nav, Pane, Text, Workspace } from "../src/v2";

// Mail's workspace in small: a sidebar (Nav) of the default width, a list of 320 to 432 px and, while a mail is open,
// a reader that keeps 400 px, which the workspace declares (`detail`). The test sets the window so the workspace is as
// wide as Mail's at 1024 px (958 px), opens or closes the reader through `window.__k2Reader` and takes the declaration
// away through `window.__k2Declare`.

declare global {
  interface Window {
    __k2Reader?: (open: boolean) => void;
    __k2Declare?: (declared: boolean) => void;
  }
}

const items = [
  { icon: "inbox", label: "Posteingang", href: "#inbox", count: 12 },
  { icon: "send", label: "Gesendet", href: "#sent" },
  { icon: "archive", label: "Archiv", href: "#archive" },
];

export function Fixture() {
  const [reader, setReader] = createSignal(true);
  const [declared, setDeclared] = createSignal(true);
  if (typeof window !== "undefined") {
    window.__k2Reader = setReader;
    window.__k2Declare = setDeclared;
  }
  return (
    <LocaleProvider locale="de">
      <Workspace
        sidebarLabel="Breite der Seitenleiste"
        detail={declared()}
        sidebar={<Nav title="Mail" icon="mail" groups={[{ items: items.map((item, index) => ({ ...item, current: index === 0 })) }]} />}
        head={
          <Bar
            start={
              <Text type="row" weight="strong">
                Posteingang
              </Text>
            }
            end={<Button variant="primary">Neue Nachricht</Button>}
          />
        }
      >
        <Pane.Split>
          <Pane label="Liste" width={{ min: 320, default: 432 }}>
            <Text>Zwölf Nachrichten.</Text>
          </Pane>
          <Show when={reader()}>
            <Pane label="Leser" detail>
              <Text>Die geöffnete Nachricht.</Text>
            </Pane>
          </Show>
        </Pane.Split>
      </Workspace>
    </LocaleProvider>
  );
}
