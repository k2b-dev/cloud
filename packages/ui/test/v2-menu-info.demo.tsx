import { Bar, Menu, type MenuEntry, Pane, Text, Workspace } from "../src/v2";

// A menu that also lists things without a deed, as the members of a space: under the heading "Mitglieder" each person
// with a sign, the name and the role, between the deeds "Einladen" and "Space verlassen". The names are invented.

declare global {
  interface Window {
    __infoDeeds?: string[];
  }
}

const did = (deed: string) => () => {
  window.__infoDeeds = [...(window.__infoDeeds ?? []), deed];
};

const items: MenuEntry[] = [
  { label: "Einladen", icon: "user-plus", onClick: did("invite") },
  {
    title: "Mitglieder",
    items: [
      { info: true, label: "Anna Berger", icon: "user", meta: "Verwaltung" },
      { info: true, label: "Jonas Hartwig", icon: "user", meta: "Mitglied" },
      { info: true, label: "Jule Amsel", icon: "user", meta: "Gast" },
    ],
  },
  { label: "Space verlassen", icon: "logout", danger: true, onClick: did("leave") },
];

export function Demo() {
  return (
    <Workspace head={<Bar start={<Text type="lead">Werkstatt</Text>} end={<Menu items={items}>Mitglieder</Menu>} />}>
      <Pane label="Werkstatt">
        <Text>Der Space der Werkstatt.</Text>
      </Pane>
    </Workspace>
  );
}
