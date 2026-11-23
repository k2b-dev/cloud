import { createSignal, For, Match, Show, Switch } from "solid-js";
import { LocaleProvider } from "../src/intl/locale";
import {
  Bar,
  Button,
  Chip,
  Empty,
  Failed,
  Inline,
  Input,
  List,
  Loading,
  Nav,
  type OnNavigate,
  Pane,
  Row,
  StatusRow,
  Table,
  Tabs,
  Workspace,
} from "../src/v2";

// A Mail-like screen for the states (loading, loaded, empty, failed) in a list and a table, the search field with its
// end place, keys and focus, and every link that can open its page in place (`href` + `onNavigate`). It starts loading
// on the server; the test switches the state in the browser through `window.__k2SetState`.

export type FixtureState = "loading" | "loaded" | "empty" | "failed";

declare global {
  interface Window {
    /** What the handlers saw: `name:pointer` or `name:keyboard` for a navigation in place, and the deeds. */
    __k2Seen?: string[];
    __k2SetState?: (state: FixtureState) => void;
  }
}

const seen = (entry: string) => {
  if (typeof window === "undefined") return;
  window.__k2Seen ??= [];
  window.__k2Seen.push(entry);
};

/** Opens the page in place: the link does not move the page, the handler notes how it was reached. */
const inPlace =
  (name: string): OnNavigate =>
  (event) => {
    event.preventDefault();
    seen(`${name}:${event.detail === 0 ? "keyboard" : "pointer"}`);
  };

const mails = [
  { id: "m1", from: "Holzwerk Brandt", subject: "Angebot AN-4471", preview: "Anbei unser Angebot für die Eichenplatten.", time: "09:42" },
  { id: "m2", from: "Jonas Hartwig", subject: "Termin Montage", preview: "Passt Ihnen Donnerstag um zehn?", time: "08:15" },
  { id: "m3", from: "Lackfabrik Nordhaus", subject: "Lieferung KW 49", preview: "Die Lieferung kommt zwei Tage später.", time: "Gestern" },
];

type Order = { id: string; name: string; sum: string };
const orders: Order[] = [
  { id: "AU-1", name: "Einbauschrank Flur", sum: "180,50 €" },
  { id: "AU-2", name: "Treppe Haus am Hang", sum: "617,00 €" },
  { id: "AU-3", name: "Küche Lindqvist", sum: "6.212,00 €" },
];

export function Fixture() {
  const [state, setState] = createSignal<FixtureState>("loading");
  if (typeof window !== "undefined") window.__k2SetState = setState;
  let search: HTMLInputElement | HTMLTextAreaElement | undefined;
  return (
    <LocaleProvider locale="de">
      <Workspace
        sidebar={
          <Nav
            title="Mail"
            icon="mail"
            groups={[
              {
                items: [
                  { label: "Posteingang", icon: "inbox", href: "#nav-inbox", onNavigate: inPlace("nav"), current: true, count: 3 },
                  { label: "Gesendet", icon: "send", href: "#nav-sent" },
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
                  { label: "Alle", href: "#tab-all", onNavigate: inPlace("tab"), current: true },
                  { label: "Ungelesen", href: "#tab-unread", onNavigate: inPlace("tab") },
                ]}
              />
            }
            end={
              <>
                <Input
                  type="search"
                  icon="search"
                  label="Suchen"
                  placeholder="Suchen"
                  ref={search}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement)) return;
                    event.preventDefault();
                    seen(`search:${event.target.value}`);
                  }}
                  end={<Button variant="ghost" icon="adjustments-horizontal" label="Filter" onClick={() => seen("filter")} />}
                />
                <Button keep onClick={() => search?.focus()}>
                  Suche fokussieren
                </Button>
              </>
            }
          />
        }
        primary={{ label: "Verfassen", icon: "pencil", href: "#compose", onNavigate: inPlace("primary") }}
      >
        <Pane.Split>
          <Pane label="Liste" width={{ min: 280, default: 360 }} status={<StatusRow lead="3 ungelesen" />}>
            <Switch>
              <Match when={state() === "loading"}>
                <Loading rows={3} lines={3} />
              </Match>
              <Match when={state() === "failed"}>
                <Failed
                  text="Unterhaltungen konnten nicht geladen werden. Deine Ansicht und Auswahl bleiben erhalten."
                  onRetry={() => {
                    seen("retry");
                    setState("loaded");
                  }}
                />
              </Match>
              <Match when={state() === "empty"}>
                <Empty
                  icon="inbox"
                  text="Keine Unterhaltungen in diesem Ordner."
                  action={{ label: "Filter zurücksetzen", onClick: () => seen("reset") }}
                />
              </Match>
              <Match when={state() === "loaded"}>
                <List label="Unterhaltungen">
                  <For each={mails}>
                    {(mail) => (
                      <Row
                        lines={[mail.from, mail.subject, mail.preview]}
                        time={mail.time}
                        href={`#${mail.id}`}
                        onNavigate={inPlace(`row-${mail.id}`)}
                      />
                    )}
                  </For>
                </List>
              </Match>
            </Switch>
          </Pane>
          <Pane label="Aufträge">
            <Show
              when={state() !== "failed"}
              fallback={
                <Failed text="Aufträge konnten nicht geladen werden. Der Filter bleibt erhalten." onRetry={() => setState("loaded")} />
              }
            >
              <Table
                label="Aufträge"
                rowKey={(order) => order.id}
                columns={[
                  { title: "Auftrag", cell: (order) => order.name, width: { min: 160, default: 240 } },
                  { title: "Betrag", align: "end", cell: (order) => order.sum },
                ]}
                rows={state() === "loaded" ? orders : []}
                loading={state() === "loading"}
                empty={{ icon: "table", text: "Keine Aufträge mit diesem Filter." }}
                open={(order) => ({ href: `#${order.id}`, onNavigate: inPlace(`order-${order.id}`) })}
                phone={(order) => ({ lines: [order.name, order.sum] })}
              />
            </Show>
            <Inline>
              <Chip href="#chip" onNavigate={inPlace("chip")}>
                1 verknüpft
              </Chip>
            </Inline>
          </Pane>
        </Pane.Split>
      </Workspace>
    </LocaleProvider>
  );
}
