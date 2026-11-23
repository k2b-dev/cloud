import type { JSX } from "solid-js";
import { MailScreen } from "./mail-screen";
import { RecordScreen } from "./record-screen";
import V2Inspect from "./V2Inspect.island";
import V2InspectSwitch from "./V2InspectSwitch.island";

/** One v2 demo screen: what it is, the approved mockup it is measured against, the colour of its app. */
export type V2Screen = {
  title: string;
  description: string;
  mockup: string;
  app?: { color: string; ink: string; tint: string };
  render: () => JSX.Element;
};

export const v2Screens = {
  mail: {
    title: "Mail",
    description:
      "The inbox: sidebar, a head with views, a status row, rows of three lines, and the reader with a summary, the reply, the message, its attachments and an internal note.",
    mockup: "mail.html",
    app: { color: "#0f766e", ink: "#0f5f59", tint: "#e8f4f2" },
    render: () => <MailScreen />,
  },
  record: {
    title: "Kundenakte",
    description:
      "One customer record of Warenfluss: the identity in the head, tabs, a pinned note, three statements, what is due, the latest deliveries, the contact history and the info column with its map.",
    mockup: "akte.html",
    render: () => <RecordScreen />,
  },
} satisfies Record<string, V2Screen>;

export type V2ScreenName = keyof typeof v2Screens;

/**
 * A screen on a page of its own, framed like the Cloud shell of the mockup (rail 56 px, the app card inset 8 px; the
 * phone bar 52 px), so it is measured at 1440 and 390 px exactly like the mockup. The frame is Fibel's, not part of v2.
 */
export const V2ScreenPage = (props: { name: V2ScreenName }) => {
  const screen: V2Screen = v2Screens[props.name];
  return (
    <div
      class="k2-ui ui-v2-screen"
      style={screen.app ? { "--k2-app": screen.app.color, "--k2-app-ink": screen.app.ink, "--k2-app-tint": screen.app.tint } : undefined}
    >
      <div class="ui-v2-screen__card">{screen.render()}</div>
      <V2Inspect />
    </div>
  );
};

/** The Fibel page of a screen: what it shows, where its knowledge lives, and the screen itself in a frame. */
export const V2DemoPage = (props: { name: V2ScreenName; title: string }) => {
  const screen: V2Screen = v2Screens[props.name];
  const frame = `v2-frame-${props.name}`;
  const src = `/en/ui/v2/screen/${props.name}`;
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
          <p>{screen.description}</p>
          <p>
            Every part of this screen is a v2 primitive; the screen has no CSS of its own. How to build it is in the agent skill{" "}
            <code>k2b-ui</code>, which ships with the package. Measured against the approved mockup <code>{screen.mockup}</code> at 1440 and
            390 px.
          </p>
          <p class="ui-v2-demo__actions">
            <V2InspectSwitch frame={frame} />
            <a href={src}>Open the screen on its own</a>
          </p>
        </div>
        <iframe id={frame} class="ui-v2-demo__frame" src={src} title={`${screen.title}, built with @k2b/ui/v2`} />
      </div>
    </article>
  );
};
