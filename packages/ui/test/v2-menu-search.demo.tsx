import { createSignal, For } from "solid-js";
import { Bar, List, Menu, type MenuEntry, Pane, Row, Workspace } from "../src/v2";

// A menu that searches, as the "+" of a task board would use it: a blank task first, then templates in two sections
// with what they fill in, then "Vorlage anlegen …". With the search, a text no template matches becomes the blank
// task's title. Every deed lands in `window.__deeds`, so a test reads what ran. `?few` shows three templates, below the
// menu's `from`, so it stays a plain menu.

declare global {
  interface Window {
    __deeds?: string[];
    /** With `?async`: the server's answer to the last "Leere Aufgabe „…“", given by the test. */
    __answer?: { ok: () => void; fail: () => void };
  }
}

const did = (deed: string) => () => {
  window.__deeds = [...(window.__deeds ?? []), deed];
};

const templates = [
  { section: "Werkstatt", name: "Möbel aufarbeiten", hint: "in 3 Tagen · Checkliste 4" },
  { section: "Werkstatt", name: "Uhr zur Revision", hint: "nächster Fr" },
  { section: "Werkstatt", name: "Polsterarbeit", hint: "in 7 Tagen" },
  { section: "Werkstatt", name: "Rahmen vergolden", hint: "in 5 Tagen" },
  { section: "Laden", name: "Schaufenster umbauen", hint: "Mo · 09:00" },
  { section: "Laden", name: "Palette annehmen", hint: "heute · dringend" },
  { section: "Laden", name: "Fotos für den Shop", hint: "morgen · Checkliste 6" },
  { section: "Laden", name: "Preisschilder drucken", hint: "heute" },
  { section: "Laden", name: "Inventur Halle B", hint: "letzter Fr im Monat" },
];

export function Demo() {
  const few = typeof location !== "undefined" && new URLSearchParams(location.search).has("few");
  const list = few ? templates.slice(0, 3) : templates;
  const [tasks, setTasks] = createSignal<string[]>([]);
  const add = (title: string) => () => {
    did(`task:${title}`)();
    setTasks([...tasks(), title]);
  };
  // `?async`: a task without a template is made on the server, which answers when the test says so
  const slow = typeof location !== "undefined" && new URLSearchParams(location.search).has("async");
  const make = (title: string) => () =>
    slow
      ? new Promise<void>((resolve, reject) => {
          window.__answer = {
            ok: () => {
              add(title)();
              resolve();
            },
            fail: () => reject(new Error("offline")),
          };
        })
      : add(title)();
  const sections = [...new Set(list.map((template) => template.section))];
  const items: MenuEntry[] = [
    { label: "Leere Aufgabe", icon: "square-plus", meta: "N", onClick: add("Neue Aufgabe") },
    ...sections.map((section) => ({
      title: section,
      items: list
        .filter((template) => template.section === section)
        .map((template) => ({ label: template.name, icon: "template", meta: template.hint, onClick: add(template.name) })),
    })),
    { label: "Vorlage anlegen …", icon: "plus", onClick: did("create-template") },
  ];
  return (
    <Workspace head={<Bar start={<span>Aufgaben</span>} />}>
      <Pane
        label="Aufgaben"
        // in the status row, so the menu stays on the phone, where a head's buttons give way
        status={
          <Bar
            start={<span>{tasks().length} Aufgaben</span>}
            end={
              <Menu
                variant="primary"
                icon="plus"
                items={items}
                search={{
                  label: "Vorlage suchen",
                  from: 8,
                  empty: (query) => `Keine Vorlage passt zu „${query}“.`,
                  fallback: (query) => ({
                    title: "Ohne Vorlage",
                    items: [{ label: `Leere Aufgabe „${query}“`, icon: "square-plus", onClick: make(query) }],
                  }),
                }}
              >
                Neu
              </Menu>
            }
          />
        }
      >
        <List label="Aufgaben">
          <For each={tasks()}>{(task) => <Row lines={[task, "Offen"]} icon="checkbox" />}</For>
        </List>
      </Pane>
    </Workspace>
  );
}
