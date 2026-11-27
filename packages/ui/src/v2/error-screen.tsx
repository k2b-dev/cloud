import { createUniqueId, type JSX, Show } from "solid-js";
import { Icon } from "./marks";

export type ErrorScreenProps = {
  /** The status as it is known, such as "404": drawn large as an outline, the sign of the page. Never an icon on it. */
  code: string;
  /** What happened, in the words of the page: "Diese Seite gibt es nicht". */
  title: string;
  /** One sentence that says why or what now. */
  text: string;
  /**
   * The ways out: first the primary `Button`, then one secondary. They stand side by side, and one below the other at
   * full width on the phone.
   */
  actions: JSX.Element;
  /** A quiet invitation at the foot of the page, such as the waiting game; it never moves what stands above. */
  foot?: JSX.Element;
};

/**
 * A page that stands in for one that could not open (403, 404, 5xx): the code as a large hairline numeral, the title,
 * one sentence and the ways out, in the middle of its place, with a quiet foot below. It has no head of its own; the
 * shell around it says where the person is. Stand it alone in a `Pane`.
 *
 * Its place is a stage too: a layer that plays in it (such as the waiting game, appended to the screen) sets
 * `data-k2-stage` on the screen. The code then steps aside, the words move to the top and stay above the layer and
 * reachable, and the foot gives way; the layer has the room below the ways out.
 */
const ErrorScreenRoot = (props: ErrorScreenProps) => {
  const title = createUniqueId();
  return (
    <section class="k2-errorscreen" data-k2-part="ErrorScreen" aria-labelledby={title}>
      <div class="k2-es-stack">
        {/* a drawing of the code, like an avatar's initials: it has no type role of the text around it */}
        <div class="k2-es-code" aria-hidden="true" data-k2-glyph="">
          {props.code}
        </div>
        <h1 class="k2-es-title k2-t-figure" id={title}>
          {props.title}
        </h1>
        <p class="k2-es-text">{props.text}</p>
        <div class="k2-es-actions">{props.actions}</div>
      </div>
      <Show when={props.foot}>
        <div class="k2-es-foot">{props.foot}</div>
      </Show>
    </section>
  );
};

export type ErrorScreenInviteProps = {
  /** A Tabler icon before the words, such as `robot`. */
  icon: string;
  /** The deed in one sentence, its name for assistive technology: "Mini-Spiel starten". */
  label: string;
  /** The invitation on a device with a pointer and keys: "Leertaste drücken, um dir die Zeit zu vertreiben". */
  keys: string;
  /** The invitation on a touch device: "Tippen, um dir die Zeit zu vertreiben". */
  touch: string;
  onClick: () => void;
};

/**
 * The quiet invitation at the foot of an error screen: a symbol and words, no frame, still a button (focusable, Enter
 * and Space press it). Both wordings stand in the server's markup; the stylesheet shows the one that fits the device,
 * so the first render is the server's.
 */
const ErrorScreenInvite = (props: ErrorScreenInviteProps) => (
  <button type="button" class="k2-es-invite" data-k2-part="ErrorScreen.Invite" aria-label={props.label} onClick={props.onClick}>
    <Icon name={props.icon} />
    <span class="k2-es-invite-keys" aria-hidden="true">
      {props.keys}
    </span>
    <span class="k2-es-invite-touch" aria-hidden="true">
      {props.touch}
    </span>
  </button>
);

/**
 * A page that stands in for one that could not open (403, 404, 5xx); `ErrorScreen.Invite` is the quiet invitation for
 * its foot, such as the waiting game.
 */
export const ErrorScreen = Object.assign(ErrorScreenRoot, { Invite: ErrorScreenInvite });
