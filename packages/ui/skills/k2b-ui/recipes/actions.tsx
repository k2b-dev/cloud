// Recipe: where deeds stand. The head holds the views, a hint, a filter menu with ticks, a view menu and the one main action;
// each row has its deeds behind its own "…" and on a right-click or a long press (a shortcut as keycaps), plus a star
// that is pressed or not and says so in the row's status.
// An offer the address names opens beside the list with its own deeds in its head; "Senden" turns while it sends, and a deed that cannot be
// taken now is disabled in a notice that says why. Deleting an offer answers with a toast and "Rückgängig".
import {
  Bar,
  Button,
  Facts,
  List,
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

type Offer = { id: string; title: string; customer: string; amount: string; starred: boolean };

const offers: Offer[] = [
  { id: "AN-2611-014", title: "Einbauschrank Flur", customer: "Familie Oswald", amount: "4.860,00 €", starred: true },
  { id: "AN-2611-015", title: "Küchenfront Eiche", customer: "Architekturbüro Winter", amount: "7.240,00 €", starred: false },
  { id: "AN-2611-017", title: "Regal Archiv", customer: "Stadtwerke Auental", amount: "2.115,50 €", starred: false },
  { id: "AN-2611-018", title: "Garderobe mit Bank", customer: "Praxis Dr. Lindner", amount: "1.390,00 €", starred: false },
];

type Props = {
  /** The offer the address names: it stands beside the list (on the phone it is the page). */
  open?: string;
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
  const open = () => list().find((offer) => offer.id === props.open);
  // what just happened to a row, heard politely in its status ("Gemerkt")
  const [said, setSaid] = createSignal<Record<string, string>>({});
  const star = (offer: Offer) => {
    setList(list().map((each) => (each.id === offer.id ? { ...each, starred: !each.starred } : each)));
    setSaid({ ...said(), [offer.id]: offer.starred ? "Nicht mehr gemerkt" : "Gemerkt" });
  };
  const remove = (offer: Offer) => {
    const before = list();
    setList(before.filter((each) => each.id !== offer.id));
    toast(`„${offer.title}“ gelöscht`, { undo: () => setList(before) });
  };
  // The same deeds behind the row's "…" and on its right-click: one list, given to both.
  const deeds = (offer: Offer): MenuEntry[] => [
    { label: "Öffnen", icon: "external-link", href: `#${offer.id}` },
    { label: "Duplizieren", icon: "copy", keys: "mod+d" },
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
                { label: "Aufträge", icon: "clipboard-list", count: 34 },
                { label: "Kunden", icon: "users", count: 412 },
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
          status={<StatusRow lead={`${list().length} offen`} facts={[{ before: "Summe", value: "15.605,50 €" }]} />}
        >
          <List label="Offene Angebote">
            <For each={list()}>
              {(offer) => (
                <Menu.Context items={deeds(offer)}>
                  <Row
                    icon="file-invoice"
                    lines={[offer.title, offer.customer]}
                    meta={offer.amount}
                    status={said()[offer.id] ?? ""}
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
                  start={<Text type="lead">{offer().title}</Text>}
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
                    { label: "Gültig bis", value: "12. Dez. 2026" },
                  ]}
                />
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
  open: () => <OfferActions open="AN-2611-015" />,
  sending: () => <OfferActions open="AN-2611-015" sending />,
  menu: { render: () => <OfferActions />, press: "Aktionen für Regal Archiv" },
  view: { render: () => <OfferActions />, press: "Ansicht" },
};
