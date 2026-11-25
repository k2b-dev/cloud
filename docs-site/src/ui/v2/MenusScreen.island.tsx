import { Bar, Button, Check, List, Menu, type MenuEntry, Nav, Pane, Popover, Row, Section, Text, useToast, Workspace } from "@k2b/ui/v2";
import { createSignal, For } from "solid-js";

// Menu, Popover and Toast of @k2b/ui/v2 on a list of orders in Grids: "Neu" opens a menu with a submenu of templates,
// the view menu holds a choice of order and settings that toggle, each under its heading, the filter is a panel, the refresh button has a hint. Every row has its deeds
// on a right-click or a long press and behind its own "…"; deleting one answers with a toast and "Rückgängig".

type Order = { id: string; title: string; customer: string };

const all: Order[] = [
  { id: "A-1042", title: "Einbauschrank Flur", customer: "Familie Oswald" },
  { id: "A-1043", title: "Küchenfront Eiche", customer: "Architekturbüro Winter" },
  { id: "A-1044", title: "Regal Archiv", customer: "Stadtwerke Auental" },
  { id: "A-1045", title: "Garderobe mit Bank", customer: "Praxis Dr. Lindner" },
];

export default function MenusScreen() {
  const toast = useToast();
  const [orders, setOrders] = createSignal(all);
  const [grouped, setGrouped] = createSignal(true);
  const [done, setDone] = createSignal(false);
  const [sort, setSort] = createSignal("due");
  const [urgent, setUrgent] = createSignal(false);
  const [mine, setMine] = createSignal(true);
  const remove = (order: Order) => {
    const before = orders();
    setOrders(before.filter((each) => each.id !== order.id));
    toast(`„${order.title}“ gelöscht`, { undo: () => setOrders(before) });
  };
  const rowMenu = (order: Order): MenuEntry[] => [
    { label: "Öffnen", icon: "external-link" },
    { label: "Duplizieren", icon: "copy", meta: "⌘ D" },
    { label: "Verschieben nach", icon: "folder", items: [{ label: "Werkstatt" }, { label: "Lager" }, { label: "Archiv", disabled: true }] },
    { label: "Löschen", icon: "trash", danger: true, onClick: () => remove(order) },
  ];
  const view = (): MenuEntry[] => [
    {
      title: "Sortieren nach",
      choice: sort(),
      onChoose: setSort,
      items: [
        { label: "Fälligkeit", value: "due" },
        { label: "Kunde", value: "customer" },
        { label: "Nummer", value: "id" },
      ],
    },
    {
      title: "Anzeigen",
      items: [
        { label: "Nach Kunde gruppieren", checked: grouped(), onClick: () => setGrouped(!grouped()) },
        { label: "Erledigte zeigen", checked: done(), onClick: () => setDone(!done()) },
      ],
    },
    { label: "Als CSV exportieren", icon: "download" },
    { label: "Drucken", icon: "printer", disabled: true },
  ];
  return (
    <Workspace
      sidebarLabel="Breite der Seitenleiste"
      primary={{ label: "Neuer Auftrag", icon: "plus" }}
      sidebar={
        <Nav
          title="Grids"
          icon="table"
          groups={[
            {
              label: "Werkstatt",
              items: [
                { label: "Aufträge", icon: "table", count: orders().length, current: true },
                { label: "Material", icon: "table", count: 128 },
                { label: "Kunden", icon: "table", count: 412 },
              ],
            },
          ]}
        />
      }
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
                <Button variant="ghost" icon="refresh" label="Aktualisieren" />
              </Popover>
              <Popover
                icon="filter"
                title="Filter"
                content={
                  <>
                    <Check name="mine" label="Nur meine" checked={mine()} onChange={setMine} />
                    <Check name="urgent" label="Nur eilige" checked={urgent()} onChange={setUrgent} />
                  </>
                }
              >
                Filter
              </Popover>
              <Menu label="Ansicht" icon="adjustments-horizontal" items={view()} />
              <Menu
                variant="primary"
                icon="plus"
                items={[
                  { label: "Leerer Auftrag", icon: "file" },
                  {
                    label: "Aus Vorlage",
                    icon: "template",
                    items: [{ label: "Einbauschrank" }, { label: "Küchenfront" }, { label: "Reparatur" }],
                  },
                ]}
              >
                Neu
              </Menu>
            </>
          }
        />
      }
    >
      <Pane label="Aufträge">
        <Section title="Offen" count={orders().length}>
          <List label="Offene Aufträge">
            <For each={orders()}>
              {(order) => (
                <Menu.Context items={rowMenu(order)}>
                  <Row
                    lines={[order.title, order.customer]}
                    icon="hammer"
                    meta={order.id}
                    end={<Menu label={`Aktionen für ${order.title}`} items={rowMenu(order)} />}
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
