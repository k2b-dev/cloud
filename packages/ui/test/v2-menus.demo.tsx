import { createSignal, For } from "solid-js";
import { Bar, Button, Check, List, Menu, type MenuEntry, Pane, Popover, Row, Section, Tabs, Text, useToast, Workspace } from "../src/v2";

// Menu, Popover and Toast of v2 in the places the mockup puts them: the "…" of a head (07-formular-menue), a filter
// panel and a hint in the same head, a context menu and a "…" on rows, a tab "Weitere" that opens the views without a
// tab of their own, and a toast with "Undo" after a deed. Each deed
// lands in `window.__deeds`, so a test reads what ran.

declare global {
  interface Window {
    __deeds?: string[];
    /** A view more under "Weitere": the app builds its tabs again while their menu may be open. */
    __moreViews?: () => void;
    /** Where the last Escape went: to the page, or taken by something on it (the toast test). */
    __escape?: "none" | "page" | "taken";
  }
}

const did = (deed: string) => () => {
  window.__deeds = [...(window.__deeds ?? []), deed];
};

const orders = [
  { id: "A-1042", title: "Einbauschrank Flur", customer: "Familie Oswald" },
  { id: "A-1043", title: "Küchenfront", customer: "Architekturbüro Winter" },
  { id: "A-1044", title: "Regal Archiv", customer: "Stadtwerke Auental" },
];

export function Demo() {
  const [openOnly, setOpenOnly] = createSignal(true);
  const [urgent, setUrgent] = createSignal(false);
  const [views, setViews] = createSignal(["Archiv", "Vorlagen"]);
  if (typeof window !== "undefined") window.__moreViews = () => setViews([...views(), `Ansicht ${views().length + 1}`]);
  // the open reply of Mail: one choice for the kind of reply and one for the sender
  const [kind, setKind] = createSignal("reply");
  const [sender, setSender] = createSignal("anna@werkstatt.example");
  const toast = useToast();
  const head = (): MenuEntry[] => [
    { label: "Als Vorlage speichern", icon: "template", onClick: did("template") },
    { label: "Auftrag duplizieren", icon: "copy", meta: "⌘ D", onClick: did("duplicate") },
    {
      label: "Verschieben nach",
      icon: "folder",
      items: [
        { label: "Werkstatt", onClick: did("move:werkstatt") },
        { label: "Lager", onClick: did("move:lager") },
        { label: "Archiv", disabled: true, onClick: did("move:archiv") },
      ],
    },
    // an entry that comes and goes: while closed orders show, it stands where the tick stood before
    ...(openOnly() ? [] : [{ label: "Alle zeigen", icon: "list", onClick: did("show-all") }]),
    {
      label: "Nur offene zeigen",
      checked: openOnly(),
      onClick: () => {
        const next = !openOnly();
        setOpenOnly(next);
        did(`open-only:${next}`)();
      },
    },
    { label: "Exportieren", icon: "download", disabled: true, onClick: did("export") },
    { label: "Verwerfen", icon: "trash", danger: true, onClick: did("discard") },
  ];
  const rowMenu = (id: string): MenuEntry[] => [
    { label: "Öffnen", icon: "external-link", onClick: did(`open:${id}`) },
    { label: "Duplizieren", icon: "copy", onClick: did(`duplicate:${id}`) },
    { label: "Löschen", icon: "trash", danger: true, onClick: did(`delete:${id}`) },
  ];
  return (
    <Workspace
      head={
        <Bar
          start={
            <Text type="row" weight="strong">
              Aufträge
            </Text>
          }
          end={
            <>
              <Popover tip="Neu laden">
                <Button variant="ghost" icon="refresh" label="Aktualisieren" onClick={did("reload")} />
              </Popover>
              <Popover
                icon="filter"
                title="Filter"
                content={
                  <>
                    <Check name="urgent" label="Nur eilige" checked={urgent()} onChange={setUrgent} />
                    <Check name="open" label="Nur offene" checked={openOnly()} onChange={setOpenOnly} />
                  </>
                }
              >
                Filter
              </Popover>
              <Button
                onClick={() => {
                  did("save")();
                  toast("Auftrag gespeichert", { status: "ok", undo: did("undo") });
                }}
              >
                Speichern
              </Button>
              <Menu
                icon="arrow-back-up"
                items={[
                  {
                    title: "Antwortart",
                    choice: kind(),
                    onChoose: (value) => {
                      setKind(value);
                      did(`kind:${value}`)();
                    },
                    items: [
                      { label: "Antworten", value: "reply", icon: "arrow-back-up" },
                      { label: "Allen antworten", value: "all", icon: "arrow-back-up-double" },
                      { label: "Weiterleiten", value: "forward", icon: "arrow-forward-up" },
                    ],
                  },
                  {
                    title: "Absender",
                    choice: sender(),
                    onChoose: (value) => {
                      setSender(value);
                      did(`sender:${value}`)();
                    },
                    items: [{ label: "anna@werkstatt.example" }, { label: "info@werkstatt.example" }],
                  },
                  { title: "Entwurf", items: [{ label: "Verwerfen", icon: "trash", danger: true, onClick: did("draft:discard") }] },
                ]}
              >
                Antwort
              </Menu>
              <Menu label="Weitere Aktionen" items={head()} />
            </>
          }
        />
      }
    >
      <Pane
        label="Aufträge"
        head={
          <Tabs
            label="Ansichten"
            items={[
              { label: "Offen", current: true, onClick: did("view:offen") },
              { label: "Erledigt", onClick: did("view:erledigt") },
              {
                label: "Weitere",
                count: `+${views().length}`,
                menu: views().map((name) => ({ label: name, onClick: did(`view:${name.toLowerCase()}`) })),
              },
            ]}
          />
        }
      >
        <Section title="Offen" count={orders.length}>
          <List label="Offene Aufträge">
            <For each={orders}>
              {(order) => (
                <Menu.Context items={rowMenu(order.id)}>
                  <Row
                    lines={[order.title, order.customer]}
                    icon="hammer"
                    onOpen={did(`row:${order.id}`)}
                    end={<Menu label={`Aktionen für ${order.title}`} items={rowMenu(order.id)} />}
                  />
                </Menu.Context>
              )}
            </For>
          </List>
        </Section>
      </Pane>
    </Workspace>
  );
}
