import { createSignal, For, Show } from "solid-js";
import { Bar, Button, Dialog, Input, List, Loading, Menu, Row, Text } from "../src/v2";

// A choice menu as the Assistant's "Alle Chats" has it (#4361): in an open Dialog, beside a search that loads the list
// again 180 ms after the last keystroke (the list gives way to placeholders while it loads, the foot's buttons are
// disabled), the filter is a Menu with one choice whose button names the chosen view. Each choice lands in
// `window.__choices`. The names are invented.

declare global {
  interface Window {
    __choices?: string[];
  }
}

const views = [
  { value: "all", label: "Alle Chats" },
  { value: "open", label: "Offen" },
  { value: "archived", label: "Archiviert" },
];

export function Demo() {
  const [view, setView] = createSignal("all");
  const [query, setQuery] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const search = (value: string) => {
    setQuery(value);
    clearTimeout(timer);
    timer = setTimeout(() => {
      setLoading(true);
      setTimeout(() => setLoading(false), 120);
    }, 180);
  };
  const label = () => views.find((each) => each.value === view())?.label ?? "Alle Chats";
  const rows = () => ["Rechnung 2026-118 prüfen", "Angebot Küche Oswald", "Lieferung Treppe"].filter((row) => row.includes(query()));
  return (
    <Dialog
      title="Alle Chats"
      open
      onOpenChange={() => undefined}
      foot={
        <>
          <Text muted>Seite 1 von 1</Text>
          <Button icon="chevron-left" disabled={loading()}>
            Zurück
          </Button>
        </>
      }
    >
      <Bar
        start={<Input type="search" icon="search" label="Chats suchen" value={query()} onInput={search} />}
        end={
          <Menu
            label="Chat-Filter"
            icon="filter"
            items={[
              {
                title: "Zeigen",
                choice: view(),
                onChoose: (value) => {
                  window.__choices = [...(window.__choices ?? []), value];
                  setView(value);
                },
                items: views.map((each) => ({ label: each.label, value: each.value })),
              },
            ]}
          >
            {label()}
          </Menu>
        }
      />
      <Show when={!loading()} fallback={<Loading rows={3} lines={1} />}>
        <List label="Chats">
          <For each={rows()}>{(row) => <Row icon="message-circle" lines={[row]} />}</For>
        </List>
      </Show>
    </Dialog>
  );
}
