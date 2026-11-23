import { For, type JSX, Show } from "solid-js";
import FormScreen from "./FormScreen.island";
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
  render: () => JSX.Element;
};

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
  record: {
    title: "Kundenakte · Überblick",
    description:
      "One customer record of Warenfluss: the identity in the head, tabs, a pinned note, three statements, what is due, the latest deliveries, the contact history and the info column with its map.",
    mockup: "akte.html",
    phone: { back: "Kunden" },
    render: () => <RecordScreen />,
  },
  deliveries: {
    title: "Kundenakte · Einlieferungen",
    description:
      "The tab Einlieferungen of the same record: every delivery in its own framed group with a tinted head and no line inside; the latest two open with their way, run-out days and returns, the older ones folded.",
    mockup: "akte-einlieferungen.html",
    phone: { back: "Kunden" },
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
      "A new order in Grids: fields in rows on one grid, the error at its field, a selection, a date, a choice, a check and a switch. Dialog, menu, the open list of a selection and the toast with Rückgängig after the main action follow with the behaviour layer.",
    mockup: "index.html (Field, Button, Menu, Toast)",
    app: "#047857",
    phone: { back: "Aufträge" },
    render: () => <FormScreen />,
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
 * A screen on a page of its own, framed like the Cloud shell of the mockup (rail 56 px, the app card inset 8 px; the
 * phone bar 52 px), so it is measured at 1440 and 390 px exactly like the mockup. The frame is Fibel's, not part of v2.
 */
export const V2ScreenPage = (props: { name: V2ScreenName }) => {
  const screen: V2Screen = v2Screens[props.name];
  return (
    <div class="k2-ui ui-v2-screen" style={screen.app ? { "--k2-app": screen.app } : undefined}>
      <PhoneBar {...screen.phone} />
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
