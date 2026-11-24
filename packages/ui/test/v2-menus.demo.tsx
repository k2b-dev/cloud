import { createSignal, For } from "solid-js";
import { Bar, Button, Check, List, Menu, type MenuEntry, Pane, Popover, Row, Section, Text, useToast, Workspace } from "../src/v2";

// Menu, Popover and Toast of v2 in the places the mockup puts them: the "…" of a head (07-formular-menue), a filter
// panel and a hint in the same head, a context menu and a "…" on rows, and a toast with "Undo" after a deed. Each deed
// lands in `window.__deeds`, so a test reads what ran.

declare global {
  interface Window {
    __deeds?: string[];
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
              <Menu label="Weitere Aktionen" items={head()} />
            </>
          }
        />
      }
    >
      <Pane label="Aufträge">
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
