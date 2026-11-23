import { type JSX, Show } from "solid-js";

export type ComposerProps = {
  /** What the composer writes, for assistive technology, such as "Reply to Holzwerk Brandt". */
  label: string;
  /** The line above the text: to whom. */
  head?: JSX.Element;
  /** The end of that line: the sender, Cc and Bcc. */
  headEnd?: JSX.Element;
  /** The text being written. Without it the composer rests and shows `placeholder`; a click on it calls `onStart`. */
  children?: JSX.Element;
  placeholder?: string;
  onStart?: () => void;
  /** Under the text, quiet: the signature that will be sent. */
  signature?: JSX.Element;
  /** The tools at the start of the foot: formatting, attachments, signature, AI. */
  tools?: JSX.Element;
  /** The deeds at the end of the foot: discard, then send. */
  actions?: JSX.Element;
};

/**
 * The frame of a message being written, as in Cloud's @k2b/ui v2 mockup: a round, framed card with a head line, the
 * text and a foot with tools and the send action. It brings its own stylesheet (`@k2b/editor/composer.css`, on the
 * v2 tokens), so the app around it writes no CSS. The app supplies the parts; the editor goes into `children`.
 */
export function Composer(props: ComposerProps) {
  return (
    <section class="k2-composer" data-k2-part="Composer" aria-label={props.label}>
      <Show when={props.head !== undefined || props.headEnd !== undefined}>
        <div class="k2-composer-head">
          {props.head}
          <Show when={props.headEnd !== undefined}>
            <div class="k2-composer-head-end">{props.headEnd}</div>
          </Show>
        </div>
      </Show>
      <div class="k2-composer-write">
        <Show
          when={props.children !== undefined}
          fallback={
            <button type="button" class="k2-composer-start" onClick={() => props.onStart?.()}>
              {props.placeholder}
            </button>
          }
        >
          {props.children}
        </Show>
        <Show when={props.signature !== undefined}>
          <div class="k2-composer-signature">{props.signature}</div>
        </Show>
      </div>
      <div class="k2-composer-foot">
        <div class="k2-composer-tools">{props.tools}</div>
        <div class="k2-composer-actions">{props.actions}</div>
      </div>
    </section>
  );
}
