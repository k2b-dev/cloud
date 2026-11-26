// Recipe: where deeds stand. The head holds the views, a hint, a filter menu with ticks, a view menu and the one main action;
// each row has its deeds behind its own "…" and on a right-click or a long press, plus a star that is pressed or not.
// An offer the address names opens beside the list with its own deeds in its head; "Senden" turns while it sends, and a deed that cannot be
// taken now is disabled in a notice that says why. Deleting an offer answers with a toast and "Rückgängig".
import {
  Avatar,
  Bar,
  Button,
  Chip,
  Facts,
  Inline,
  List,
  Mark,
  Menu,
  type MenuEntry,
  Nav,
  Notice,
  Pane,
  Popover,
  Row,
  Section,
  StatusRow,
  Tabs,
  Text,
  useToast,
  Workspace,
} from "@k2b/ui/v2";
import { createSignal, For, Show } from "solid-js";

// The app this screen belongs to: its colour tints the page and marks it in the host's rail.
export const app = { color: "#c2410c", icon: "hammer" };

// One mark per kind of work, the same in the list, the detail and every sentence.
const kind = {
  cabinet: { icon: "door", color: "#7c3aed" },
  kitchen: { icon: "tools-kitchen-2", color: "#c2410c" },
  shelf: { icon: "books", color: "#15803d" },
  repair: { icon: "hammer", color: "#0e7490" },
};

type Offer = {
  id: string;
  title: string;
  kind: keyof typeof kind;
  customer: string;
  amount: string;
  valid: string;
  expiring?: boolean;
  starred: boolean;
};

const offers: Offer[] = [
  {
    id: "AN-2611-014",
    title: "Einbauschrank Flur",
    kind: "cabinet",
    customer: "Familie Oswald",
    amount: "4.860,00 €",
    valid: "bis 2. Dez.",
    expiring: true,
    starred: true,
  },
  {
    id: "AN-2611-015",
    title: "Küchenfront Eiche",
    kind: "kitchen",
    customer: "Architekturbüro Winter",
    amount: "7.240,00 €",
    valid: "bis 12. Dez.",
    starred: false,
  },
  {
    id: "AN-2611-017",
    title: "Regal Archiv",
    kind: "shelf",
    customer: "Stadtwerke Auental",
    amount: "2.115,50 €",
    valid: "bis 14. Dez.",
    starred: false,
  },
  {
    id: "AN-2611-018",
    title: "Garderobe mit Bank",
    kind: "cabinet",
    customer: "Praxis Dr. Lindner",
    amount: "1.390,00 €",
    valid: "bis 15. Dez.",
    starred: false,
  },
  {
    id: "AN-2611-019",
    title: "Treppe abschleifen",
    kind: "repair",
    customer: "Familie Kern",
    amount: "980,00 €",
    valid: "bis 1. Dez.",
    expiring: true,
    starred: false,
  },
  {
    id: "AN-2611-021",
    title: "Küche Gemeindehaus",
    kind: "kitchen",
    customer: "Gemeinde Ohlsbach",
    amount: "11.200,00 €",
    valid: "bis 20. Dez.",
    starred: true,
  },
  {
    id: "AN-2611-022",
    title: "Weinregal Keller",
    kind: "shelf",
    customer: "Weingut Hartwig",
    amount: "2.480,00 €",
    valid: "bis 22. Dez.",
    starred: false,
  },
  {
    id: "AN-2611-024",
    title: "Fenster nachstellen",
    kind: "repair",
    customer: "Hotel Seeblick",
    amount: "640,00 €",
    valid: "bis 23. Dez.",
    starred: false,
  },
];

type Props = {
  /** The offer the address names: it stands beside the list (on the phone it is the page); `null` when none is open. */
  open?: string | null;
  /** The open offer is being sent: its "Senden" turns and takes no second press. */
  sending?: boolean;
};

export default function OfferActions(props: Props) {
  const toast = useToast();
  const [list, setList] = createSignal(offers);
  const [sort, setSort] = createSignal("due");
  const [grouped, setGrouped] = createSignal(false);
  const [mine, setMine] = createSignal(true);
  const [expiring, setExpiring] = createSignal(false);
  const open = () => (props.open === null ? undefined : list().find((offer) => offer.id === (props.open ?? "AN-2611-015")));
  const star = (offer: Offer) => setList(list().map((each) => (each.id === offer.id ? { ...each, starred: !each.starred } : each)));
  const remove = (offer: Offer) => {
    const before = list();
    setList(before.filter((each) => each.id !== offer.id));
    toast(`„${offer.title}“ gelöscht`, { undo: () => setList(before) });
  };
  // The same deeds behind the row's "…" and on its right-click: one list, given to both.
  const deeds = (offer: Offer): MenuEntry[] => [
    { label: "Öffnen", icon: "external-link", href: `#${offer.id}` },
    { label: "Duplizieren", icon: "copy", meta: "⌘ D" },
    { label: "Verschieben nach", icon: "folder", items: [{ label: "Werkstatt" }, { label: "Montage" }, { label: "Archiv" }] },
    { label: "Löschen", icon: "trash", danger: true, onClick: () => remove(offer) },
  ];
  const view = (): MenuEntry[] => [
    {
      title: "Sortieren nach",
      choice: sort(),
      onChoose: setSort,
      items: [
        { label: "Gültig bis", value: "due" },
        { label: "Kunde", value: "customer" },
        { label: "Betrag", value: "amount" },
      ],
    },
    { title: "Anzeigen", items: [{ label: "Nach Kunde gruppieren", checked: grouped(), onClick: () => setGrouped(!grouped()) }] },
    { label: "Als CSV exportieren", icon: "download" },
  ];
  return (
    <Workspace
      detail
      detailEmpty={{ icon: "file-invoice", text: "Kein Angebot ausgewählt" }}
      primary={{ label: "Neues Angebot", icon: "plus" }}
      sidebar={
        <Nav
          title="Werkstatt"
          icon="hammer"
          groups={[
            {
              items: [
                { label: "Angebote", icon: "file-invoice", count: list().length, current: true },
                { label: "Aufträge", icon: "clipboard-list", count: 34, href: "#auftraege" },
                { label: "Kunden", icon: "users", count: 412, href: "#kunden" },
              ],
            },
            {
              label: "Arten",
              items: [
                { label: "Schränke", ...kind.cabinet, href: "#schraenke" },
                { label: "Küchen", ...kind.kitchen, href: "#kuechen" },
                { label: "Regale", ...kind.shelf, href: "#regale" },
                { label: "Reparaturen", ...kind.repair, href: "#reparaturen" },
              ],
            },
          ]}
        />
      }
      head={
        <Bar
          start={
            <Tabs
              label="Ansichten"
              items={[
                { label: "Offen", count: list().length, current: true },
                { label: "Gesendet", count: 12 },
                { label: "Angenommen", count: 31 },
              ]}
            />
          }
          end={
            <>
              <Popover tip="Neu laden">
                <Button variant="ghost" icon="refresh" label="Aktualisieren" />
              </Popover>
              {/* a filter the phone needs is a Menu with ticks: a Popover in the head leaves on the phone */}
              <Menu
                icon="filter"
                items={[
                  { label: "Nur meine", checked: mine(), onClick: () => setMine(!mine()) },
                  { label: "Nur bald ablaufende", checked: expiring(), onClick: () => setExpiring(!expiring()) },
                ]}
              >
                Filter
              </Menu>
              <Menu label="Ansicht" icon="adjustments-horizontal" items={view()} />
              <Menu
                variant="primary"
                icon="plus"
                items={[
                  { label: "Leeres Angebot", icon: "file" },
                  {
                    label: "Aus Vorlage",
                    icon: "template",
                    items: [{ label: "Einbauschrank" }, { label: "Küchenfront" }, { label: "Reparatur" }],
                  },
                ]}
              >
                Neues Angebot
              </Menu>
            </>
          }
        />
      }
    >
      <Pane.Split>
        <Pane
          label="Angebote"
          width={{ min: 320, default: 420 }}
          status={
            <StatusRow
              lead="30.885,50 € offen"
              facts={[{ value: list().length, after: "Angebote" }]}
              filters={<Chip status="warn">2 laufen bald ab</Chip>}
            />
          }
        >
          <List label="Offene Angebote">
            <For each={list()}>
              {(offer) => (
                <Menu.Context items={deeds(offer)}>
                  <Row
                    mark={kind[offer.kind]}
                    lines={[offer.title, `${offer.customer} · ${offer.valid}`]}
                    meta={offer.amount}
                    marks={offer.expiring ? <Chip status="warn">Läuft ab</Chip> : undefined}
                    current={offer.id === open()?.id}
                    href={`#${offer.id}`}
                    end={
                      <>
                        <Button
                          variant="ghost"
                          icon="star"
                          label={`„${offer.title}“ merken`}
                          pressed={offer.starred}
                          onClick={() => star(offer)}
                        />
                        <Menu label={`Aktionen für ${offer.title}`} items={deeds(offer)} />
                      </>
                    }
                  />
                </Menu.Context>
              )}
            </For>
          </List>
        </Pane>
        <Show when={open()}>
          {(offer) => (
            <Pane
              detail
              label={offer().title}
              back={{ label: "Angebote", href: "#" }}
              head={
                <Bar
                  start={
                    <Inline>
                      <Mark {...kind[offer().kind]} />
                      <Text type="lead">{offer().title}</Text>
                    </Inline>
                  }
                  end={
                    <>
                      <Button icon="pencil">Bearbeiten</Button>
                      <Button icon="send" busy={props.sending}>
                        Senden
                      </Button>
                      <Menu label="Weitere Aktionen" items={deeds(offer())} />
                      <Button variant="ghost" icon="x" label="Schließen" href="#" />
                    </>
                  }
                />
              }
            >
              <Notice tone="warn" title="Freigabe fehlt" actions={[{ label: "Freigeben", icon: "check", disabled: true }]}>
                Angebote über 5.000 € gibt Jana Petersen frei. Sie ist bis Donnerstag im Urlaub.
              </Notice>
              <Section icon="list-details" title="Angaben">
                <Facts
                  items={[
                    { label: "Nummer", value: offer().id, copy: offer().id },
                    { label: "Kunde", value: offer().customer },
                    { label: "Betrag", value: offer().amount },
                    { label: "Gültig", value: offer().valid },
                    {
                      label: "Erstellt von",
                      value: (
                        <Inline>
                          <Avatar name="Felix Thal" decorative />
                          <Text>Felix Thal</Text>
                        </Inline>
                      ),
                    },
                  ]}
                />
              </Section>
              <Section icon="list" title="Positionen" count={3}>
                <Row mark={{ icon: "wood", color: "#a16207" }} lines={["Fronten Eiche massiv, geölt", "14 Stück · 3.920,00 €"]} />
                <Row mark={{ icon: "nut", color: "#475569" }} lines={["Beschläge Blum, Softclose", "28 Stück · 1.120,00 €"]} />
                <Row mark={{ icon: "truck", color: "#0e7490" }} lines={["Montage vor Ort", "2 Tage, 2 Personen · 2.200,00 €"]} />
              </Section>
            </Pane>
          )}
        </Show>
      </Pane.Split>
    </Workspace>
  );
}

// The states that Fibel's Example offers beside the default. A state with `press` opens an overlay as a person would:
// after the page is live the Example presses the buttons with these names, one after the other.
export const states = {
  closed: () => <OfferActions open={null} />,
  sending: () => <OfferActions sending />,
  // the list's own menus, while no offer is open (on the phone an open offer is the page)
  menu: { render: () => <OfferActions open={null} />, press: "Aktionen für Regal Archiv" },
  view: { render: () => <OfferActions open={null} />, press: "Ansicht" },
};
