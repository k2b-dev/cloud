import { For, type JSX, Show } from "solid-js";
import FormScreen from "./FormScreen.island";
import KeysScreen from "./KeysScreen.island";
import MailSelectScreen from "./MailSelectScreen.island";
import MailTabletScreen from "./MailTabletScreen.island";
import MenusScreen from "./MenusScreen.island";
import { MailScreen } from "./mail-screen";
import { DeliveriesScreen, RecordScreen } from "./record-screen";
import TableScreen from "./TableScreen.island";
import V2Inspect from "./V2Inspect.island";
import V2InspectSwitch from "./V2InspectSwitch.island";

/** One v2 demo screen: what it is, the approved mockup it is measured against, the colour of its app. */
export type V2Screen = {
  title: string;
  description: string;
  mockup: string;
  /** The one colour of the app (`--k2-app`); v2 derives its ink and tint in each theme. */
  app?: string;
  /** The platform's bar on the phone, as the mockup draws it: the app with its switcher, or the way back to a list. */
  phone: { app: string } | { back: string };
  /** The rail of the Cloud shell beside the app on wider screens, as the mockup draws it: its apps and the open one. */
  rail?: { apps: readonly string[]; current: string };
  render: () => JSX.Element;
};

/** The apps in the rail of the Kundenakte mockup (akte.html), Kunden open. */
const kundenRail = {
  apps: ["home", "users", "file-invoice", "building-bank", "package", "id-badge-2", "user-circle"],
  current: "users",
} as const;

export const v2Screens = {
  mail: {
    title: "Mail",
    description:
      "The inbox: sidebar, a head with views, a status row, rows of three lines, and the reader with a summary, the reply, the message, its attachments and an internal note.",
    mockup: "mail.html",
    app: "#0f766e",
    phone: { app: "Mail" },
    render: () => <MailScreen />,
  },
  "mail-list": {
    title: "Mail · nichts offen",
    description:
      "The same inbox while no message is open: on the phone the list is the page, and a row opens its message as a page of its own with the way back.",
    mockup: "mail.html (390 px)",
    app: "#0f766e",
    phone: { app: "Mail" },
    render: () => <MailScreen open={false} />,
  },
  "mail-select": {
    title: "Mail · Auswahl",
    description:
      "The same inbox with two messages selected: every row has its box in the lead, named by its sender, a selected row is blue, and the status row is the bar of what can be done with them. On the phone the list stays the page.",
    mockup: "tabelle-grids.html (selection), mail.html",
    app: "#0f766e",
    phone: { app: "Mail" },
    render: () => <MailSelectScreen />,
  },
  "mail-tablet": {
    title: "Mail · Tablet",
    description:
      "The inbox in a window of 1024 px: the sidebar does not fit beside the list and the reader, so it is a drawer from the start of the window, opened here by its button at the start of the head. The workspace keeps room for the reader also while no message is open, so opening a message never moves the sidebar. In a wider window the sidebar is a column.",
    mockup: "mail.html (concept: Schublade am Tablet)",
    app: "#0f766e",
    phone: { app: "Mail" },
    render: () => <MailTabletScreen />,
  },
  record: {
    title: "Kundenakte · Überblick",
    description:
      "One customer record of Warenfluss: the identity in the head, tabs, a pinned note, three statements, what is due, the latest deliveries, the contact history and the info column with its map.",
    mockup: "akte.html",
    phone: { back: "Kunden" },
    rail: kundenRail,
    render: () => <RecordScreen />,
  },
  deliveries: {
    title: "Kundenakte · Einlieferungen",
    description:
      "The tab Einlieferungen of the same record: every delivery in its own framed group with a tinted head and no line inside; the latest two open with their way, run-out days and returns, the older ones folded.",
    mockup: "akte-einlieferungen.html",
    phone: { back: "Kunden" },
    rail: kundenRail,
    render: () => <DeliveriesScreen />,
  },
  table: {
    title: "Große Tabelle",
    description:
      "34 orders of Grids in 11 columns, grouped by state: the head and the first column stay while scrolling, rows and cells answer the pointer, the boxes select rows and turn the status row into the bar of what can be done with them. On the phone every order becomes a row of two lines.",
    mockup: "tabelle-grids.html",
    app: "#047857",
    phone: { back: "Aufträge" },
    render: () => <TableScreen />,
  },
  form: {
    title: "Bedienung · Neuer Auftrag",
    description:
      "A new order in Grids: fields in rows on one grid, the error at its field, a selection, a date, a choice, a check and a switch. Als Vorlage speichern opens a dialog with a field, a sheet from the bottom on a phone; Abbrechen asks with Dialog.confirm before the order is discarded. More deeds wait behind „…“, and a toast with Rückgängig answers the main action.",
    mockup: "index.html (Field, Button, Menu, Toast)",
    app: "#047857",
    phone: { back: "Aufträge" },
    render: () => <FormScreen />,
  },
  keys: {
    title: "Zustände · Schlüssel eines Agenten",
    description:
      "An agent's keys in Accounts: a picture in the record head, heads that sort (press Name or Zuletzt genutzt), a busy button (press Bild ändern), disabled fields and a disabled deed of a notice, and facts with a token in monospace. On the phone the side column stands under the table, with one line between them.",
    mockup: "tabelle.html (Sortiert), index.html (Button, Field)",
    app: "#7c3aed",
    phone: { back: "Agenten" },
    render: () => <KeysScreen />,
  },
  menus: {
    title: "Menü · Popover · Toast",
    description:
      "Orders in Grids with the overlays of v2: „Neu“ opens a menu with a submenu of templates, the view menu holds a choice of order and settings that toggle, each under its heading, the filter is a panel, the refresh button has a hint. Each row has its deeds on a right-click or a long press and behind its own „…“; deleting one answers with a toast and „Rückgängig“.",
    mockup: "index.html (Menu · Popover · Toast), 07-formular-menue",
    app: "#047857",
    phone: { back: "Aufträge" },
    render: () => <MenusScreen />,
  },
} satisfies Record<string, V2Screen>;

export type V2ScreenName = keyof typeof v2Screens;

/**
 * The platform's bar above an app on the phone (52 px), drawn as the mockup has it: the app's name with its switcher,
 * or the name of the list it leads back to, then search and more. It is a picture of the Cloud shell, not part of v2,
 * so assistive technology skips it.
 */
export const PhoneBar = (props: V2Screen["phone"]) => (
  <div class="ui-v2-phonebar" aria-hidden="true">
    {/* the name's place: while an open detail brings its own way back (`Back`), that stands here instead */}
    <span class="ui-v2-phonebar__name">
      <Show
        when={"back" in props ? props.back : undefined}
        fallback={
          <>
            <span class="ui-v2-phonebar__title">{"app" in props ? props.app : ""}</span>
            <i class="ti ti-chevron-down ui-v2-phonebar__muted" />
          </>
        }
      >
        {(back) => (
          <>
            <span class="ui-v2-phonebar__button">
              <i class="ti ti-chevron-left" />
            </span>
            <span class="ui-v2-phonebar__title">{back()}</span>
          </>
        )}
      </Show>
    </span>
    <span class="ui-v2-phonebar__fill" />
    <span class="ui-v2-phonebar__button">
      <i class="ti ti-search" />
    </span>
    <span class="ui-v2-phonebar__button">
      <i class={"back" in props ? "ti ti-dots" : "ti ti-menu-2"} />
    </span>
  </div>
);

/**
 * The rail of the Cloud shell beside the app (56 px), drawn as the mockup has it: the logo, the apps with the open one
 * marked, search and help at the foot. A picture of the shell, not part of v2, so assistive technology skips it.
 */
export const RailPicture = (props: NonNullable<V2Screen["rail"]>) => (
  <div class="ui-v2-rail" aria-hidden="true">
    <span class="ui-v2-rail__logo">C</span>
    <For each={props.apps}>
      {(app) => (
        <span class="ui-v2-rail__app" data-current={app === props.current ? "" : undefined}>
          <i class={`ti ti-${app}`} />
        </span>
      )}
    </For>
    <span class="ui-v2-rail__fill" />
    <span class="ui-v2-rail__app">
      <i class="ti ti-search" />
    </span>
    <span class="ui-v2-rail__app">
      <i class="ti ti-help" />
    </span>
  </div>
);

/**
 * A screen on a page of its own, framed like the Cloud shell of the mockup (rail 56 px, the app card inset 8 px; the
 * phone bar 52 px), so it is measured at 1440 and 390 px exactly like the mockup. The frame is Fibel's, not part of v2.
 */
export const V2ScreenPage = (props: { name: V2ScreenName }) => {
  const screen: V2Screen = v2Screens[props.name];
  return (
    <div class="k2-ui ui-v2-screen" style={screen.app ? { "--k2-app": screen.app } : undefined}>
      <PhoneBar {...screen.phone} />
      <Show when={screen.rail}>{(rail) => <RailPicture {...rail()} />}</Show>
      <div class="ui-v2-screen__card">{screen.render()}</div>
      <V2Inspect />
    </div>
  );
};

/** The Fibel page of one or more screens: what they show, where the knowledge lives, and each screen in a frame. */
export const V2DemoPage = (props: { names: readonly V2ScreenName[]; title: string }) => {
  const frame = (name: V2ScreenName) => `v2-frame-${name}`;
  return (
    <article class="ui-showcase ui-reference-showcase">
      <header class="ui-reference-heading">
        <div class="ui-page-heading">
          <p>@k2b/ui/v2 · provisional</p>
          <h1>{props.title}</h1>
        </div>
      </header>
      <div class="ui-v2-demo">
        <div class="ui-v2-demo__intro">
          <p>
            Every part of {props.names.length > 1 ? "these screens" : "this screen"} is a v2 primitive; there is no CSS of its own. How to
            build it is in the agent skill <code>k2b-ui</code>, which ships with the package. Each screen is measured against its approved
            mockup at 1440 and 390 px.
          </p>
          <p class="ui-v2-demo__actions">
            <V2InspectSwitch frames={props.names.map(frame)} />
          </p>
        </div>
        <For each={props.names}>
          {(name) => {
            const screen: V2Screen = v2Screens[name];
            const src = `/en/ui/v2/screen/${name}`;
            return (
              <section class="ui-v2-demo__screen" aria-label={screen.title}>
                <h2>{screen.title}</h2>
                <p>
                  {screen.description} Mockup: <code>{screen.mockup}</code>. <a href={src}>Open the screen on its own</a>.
                </p>
                <iframe id={frame(name)} class="ui-v2-demo__frame" src={src} title={`${screen.title}, built with @k2b/ui/v2`} />
              </section>
            );
          }}
        </For>
      </div>
    </article>
  );
};
