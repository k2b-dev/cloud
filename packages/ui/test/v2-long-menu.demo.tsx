import { For } from "solid-js";
import { Bar, List, Menu, type MenuEntry, Pane, Row, Text, Workspace } from "../src/v2";

// A long menu, as the people menu of a space: 60 people behind a button in the head (it opens down from the top), and
// the same people behind the "…" of each task, where the lowest rows sit at the bottom of the screen (it has to open
// up or keep inside). The names are invented.

const people: MenuEntry[] = Array.from({ length: 60 }, (_, index) => ({
  label: `Person ${String(index + 1).padStart(2, "0")}`,
  icon: "user",
  onClick: () => undefined,
}));

const tasks = [
  "Aufmaß Küche",
  "Holz bestellen",
  "Zuschnitt",
  "Kanten anleimen",
  "Bohren",
  "Schleifen",
  "Lackieren",
  "Beschläge",
  "Vormontage",
  "Lieferung planen",
  "Montage vor Ort",
  "Abnahme",
  "Rechnung",
  "Nachkalkulation",
  "Ablage",
];

export function Demo() {
  return (
    <Workspace head={<Bar start={<Text type="lead">Team</Text>} end={<Menu items={people}>Personen</Menu>} />}>
      <Pane label="Aufgaben">
        <List label="Aufgaben">
          <For each={tasks}>
            {(task) => <Row icon="checkbox" lines={[task]} end={<Menu label={`Zuweisen: ${task}`} icon="user-plus" items={people} />} />}
          </For>
        </List>
      </Pane>
    </Workspace>
  );
}
