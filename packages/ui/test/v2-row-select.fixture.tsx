import { createSignal, For, Show } from "solid-js";
import { Bar, Button, List, Pane, Row, type RowLines, StatusRow, Text, Workspace } from "../src/v2";

// A list in a selection, as Mail draws "2 ausgewählt": every row has its box, two are chosen, and one of those is also
// the open one, whose detail stands beside the list. The server renders it, the browser hydrates it; a box changes
// only the selection, and the row still opens its entry. The detail closes in place through its way back or its ×.

type Mail = { id: string; lines: RowLines; time: string; unread?: boolean; avatar?: { name: string; color: string } };

const mails: readonly Mail[] = [
  {
    id: "brandt",
    lines: ["Holzwerk Brandt", "Angebot Eichenplatten – Liefertermin", "Guten Tag Frau Solberg, die Platten können wir in KW 49 liefern …"],
    time: "09:42",
  },
  {
    id: "hartwig",
    lines: ["Jonas Hartwig", "Frage zur Rechnung 2026-1184", "Hallo, auf der Rechnung steht ein anderer Betrag …"],
    time: "09:15",
    unread: true,
  },
  {
    id: "stadtwerke",
    lines: ["Stadtwerke Auental", "Zählerwechsel am 02.12.", "Sehr geehrte Damen und Herren, wir tauschen an diesem Tag …"],
    time: "08:50",
  },
  { id: "amsel", lines: ["Jule Amsel", "Aufmaß Treppe"], time: "gestern", avatar: { name: "Jule Amsel", color: "#7c3aed" } },
];

export function Fixture() {
  const [chosen, setChosen] = createSignal<readonly string[]>(["brandt", "stadtwerke"]);
  const toggle = (id: string, on: boolean) => setChosen((list) => (on ? [...list, id] : list.filter((each) => each !== id)));
  const [open, setOpen] = createSignal(true);
  const all = () => (chosen().length === 0 ? false : chosen().length === mails.length ? true : "mixed");
  return (
    <Workspace>
      <Pane.Split>
        <Pane
          label="Liste"
          width={{ min: 320, default: 432 }}
          status={
            <StatusRow
              lead="7 ungelesen"
              select={{ label: "Alle auswählen", checked: all(), onChange: (on) => setChosen(on ? mails.map((mail) => mail.id) : []) }}
              selection={
                chosen().length > 0
                  ? {
                      count: `${chosen().length} ausgewählt`,
                      actions: [{ label: "Archivieren", icon: "archive" }],
                      clear: { label: "Auswahl aufheben", onClick: () => setChosen([]) },
                    }
                  : undefined
              }
            />
          }
        >
          <List label="Nachrichten">
            <For each={mails}>
              {(mail) => (
                <Row
                  lines={mail.lines}
                  time={mail.time}
                  unread={mail.unread}
                  avatar={mail.avatar}
                  href={`#${mail.id}`}
                  current={mail.id === "brandt"}
                  select={{ selected: chosen().includes(mail.id), onChange: (on) => toggle(mail.id, on) }}
                />
              )}
            </For>
          </List>
        </Pane>
        <Show when={open()}>
          <Pane
            detail
            label="Nachricht"
            back={{ label: "Posteingang", href: "#posteingang", onClick: () => setOpen(false) }}
            head={
              <Bar
                start={<Text type="lead">Angebot Eichenplatten – Liefertermin</Text>}
                end={<Button variant="ghost" icon="x" label="Schließen" href="#posteingang" onClick={() => setOpen(false)} />}
              />
            }
          >
            <Text>Guten Tag Frau Solberg, die Platten können wir in KW 49 liefern.</Text>
          </Pane>
        </Show>
      </Pane.Split>
    </Workspace>
  );
}
