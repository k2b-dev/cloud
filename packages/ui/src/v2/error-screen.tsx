import { type JSX, Show } from "solid-js";

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
 */
export const ErrorScreen = (props: ErrorScreenProps) => (
  <section class="k2-errorscreen" data-k2-part="ErrorScreen" aria-labelledby="k2-errorscreen-title">
    <div class="k2-es-stack">
      {/* a drawing of the code, like an avatar's initials: it has no type role of the text around it */}
      <div class="k2-es-code" aria-hidden="true" data-k2-glyph="">
        {props.code}
      </div>
      <h1 class="k2-es-title" id="k2-errorscreen-title">
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
