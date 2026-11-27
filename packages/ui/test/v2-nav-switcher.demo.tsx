import { createSignal } from "solid-js";
import { Nav, type NavSwitcherOption, Pane, Text, Workspace } from "../src/v2";

// A sidebar with a switcher between an app's bases: the open base on the button; behind it the five opened last, then
// all the others by name, a search (12 bases, from 8 on), and "Neue Base" and "Aus Vorlage". Hooks on `window`:
// - `__switcherFew()` leaves 3 bases, so the search does not show;
// - `__switcherDid` names the last deed that was chosen.

declare global {
  interface Window {
    __switcherFew?: () => void;
    __switcherDid?: string;
  }
}

const names = ["Werkstatt", "Lager Nord", "Kunden", "Personal", "Fuhrpark", "Einkauf", "Geräteverleih", "Projekte 2026", "Buchhaltung"];
const more = ["Ausleihen", "Mängel", "Veranstaltungen"];
const option = (name: string, index: number, group: string): NavSwitcherOption => ({
  label: name,
  href: `/app/grids/B${index}`,
  icon: "database",
  color: "#0369a1",
  group,
  current: index === 0,
});
const all = [
  ...names.slice(0, 5).map((name, index) => ({ ...option(name, index, "Zuletzt geöffnet"), meta: `vor ${index + 1} Std.` })),
  ...[...names.slice(5), ...more].sort((a, b) => a.localeCompare(b, "de")).map((name, index) => option(name, index + 5, "Alle Basen")),
];

export function Demo() {
  const [options, setOptions] = createSignal<readonly NavSwitcherOption[]>(all);
  if (typeof window !== "undefined") window.__switcherFew = () => setOptions(all.slice(0, 3));
  const did = (what: string) => () => {
    if (typeof window !== "undefined") window.__switcherDid = what;
  };
  return (
    <Workspace
      sidebar={
        <Nav
          title="Grids"
          icon="table"
          switcher={{
            label: "Base wechseln",
            current: { label: "Werkstatt", icon: "database", color: "#0369a1" },
            options: options(),
            search: "Base suchen",
            noMatch: "Keine Base passt",
            actions: [
              { label: "Neue Base", icon: "plus", onClick: did("new") },
              { label: "Aus Vorlage", icon: "template", onClick: did("template") },
            ],
          }}
          groups={[{ items: [{ label: "Übersicht", icon: "layout-dashboard", href: "/app/grids/B0", current: true }] }]}
        />
      }
    >
      <Pane label="Übersicht">
        <Text>Werkstatt</Text>
      </Pane>
    </Workspace>
  );
}
