import { createSignal } from "solid-js";
import { Bar, Button, Check, Input, Menu, Pane, Popover, Text, Workspace } from "../src/v2";

// A menu entry with a panel beside it (as Mail's "Datum und Uhrzeit …" holds a calendar): the panel has a text field
// with its own key handler (delegated by Solid, as every `onKeyDown` of an app is), a popover of its own and a button
// that picks and closes the menu. What ran lands in `window.__deeds`.

declare global {
  interface Window {
    __deeds?: string[];
  }
}

const did = (deed: string) => {
  window.__deeds = [...(window.__deeds ?? []), deed];
};

const Panel = (props: { close: () => void }) => {
  const [note, setNote] = createSignal("");
  return (
    <>
      <Input
        label="Notiz"
        value={note()}
        onInput={setNote}
        onKeyDown={(event) => {
          did(`key:${event.key}`);
          if (event.key !== "Enter") return;
          event.preventDefault();
          did(`note:${note()}`);
          props.close();
        }}
      />
      <Menu label="Vorlage" items={[{ label: "Früh", onClick: () => did("early") }]}>
        Vorlage
      </Menu>
      <Popover title="Hinweis" content={<Check name="remember" label="Merken" checked={false} onChange={() => did("remember")} />}>
        Hinweis
      </Popover>
      <Button variant="primary" onClick={() => (did(`apply:${note()}`), props.close())}>
        Übernehmen
      </Button>
    </>
  );
};

const whenLabels: Record<string, string> = { today: "Heute", tomorrow: "Morgen" };

export function Demo() {
  // a value set through a submenu that is one choice without a heading, shown at its entry's end
  const [when, setWhen] = createSignal("tomorrow");
  return (
    <Workspace
      head={
        <Bar
          start={<Text type="lead">Auftrag A-1042</Text>}
          end={
            <Menu
              label="Später"
              icon="clock"
              items={[
                { label: "Morgen, 8:00", onClick: () => did("tomorrow") },
                "separator",
                { label: "Notiz und Zeit …", panel: (close) => <Panel close={close} /> },
                { label: "Gesperrt …", disabled: true, panel: (close) => <Panel close={close} /> },
                {
                  label: "Wann",
                  current: whenLabels[when()],
                  meta: "⌘ W",
                  items: [
                    {
                      title: "",
                      items: [
                        { label: "Heute", value: "today" },
                        { label: "Morgen", value: "tomorrow" },
                      ],
                      choice: when(),
                      onChoose: (value) => {
                        setWhen(value);
                        did(`when:${value}`);
                      },
                    },
                  ],
                },
              ]}
            />
          }
        />
      }
    >
      <Pane>
        <Text>Auftrag</Text>
      </Pane>
    </Workspace>
  );
}
