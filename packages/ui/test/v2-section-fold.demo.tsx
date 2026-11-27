import { createSignal, For } from "solid-js";
import { List, Pane, Row, Section, Workspace } from "../src/v2";

// Sections of a list that the person folds, as Chat's sections do (W9): "Angeheftet" starts open, "Archiviert" starts
// folded, and the app keeps each state (here in `window.__folds`). "Alle" cannot fold and stays as every section is.

declare global {
  interface Window {
    /** Every change a section asked for, as "title:open". */
    __folds?: string[];
  }
}

const chats = ["Werkstatt", "Lager", "Buchhaltung"];

const rows = (label: string) => (
  <List label={label}>
    <For each={chats}>{(chat) => <Row lines={[chat, "Zuletzt gestern"]} icon="message" />}</For>
  </List>
);

export function Demo() {
  const [pinned, setPinned] = createSignal(true);
  const [archived, setArchived] = createSignal(false);
  const keep = (title: string, set: (open: boolean) => void) => (open: boolean) => {
    window.__folds = [...(window.__folds ?? []), `${title}:${open}`];
    set(open);
  };
  return (
    <Workspace>
      <Pane label="Unterhaltungen">
        <Section
          title="Angeheftet"
          count={chats.length}
          open={pinned()}
          onOpenChange={keep("Angeheftet", setPinned)}
          summary="Drei Unterhaltungen oben"
        >
          {rows("Angeheftet")}
        </Section>
        <Section title="Archiviert" count={chats.length} open={archived()} onOpenChange={keep("Archiviert", setArchived)}>
          {rows("Archiviert")}
        </Section>
        <Section title="Alle" count={chats.length} summary="Drei Unterhaltungen oben">
          {rows("Alle")}
        </Section>
        {/* told of each change, but holding no state: it starts open and keeps its own */}
        <Section
          title="Entwürfe"
          count={chats.length}
          onOpenChange={(open) => {
            window.__folds = [...(window.__folds ?? []), `Entwürfe:${open}`];
          }}
        >
          {rows("Entwürfe")}
        </Section>
      </Pane>
    </Workspace>
  );
}
