import { type JSX, Show } from "solid-js";

/**
 * The second line of an option row, as a `<small>`, or nothing without text
 * or visual. With a `visual`, such as a colored `Tag`, the visual shows in
 * place of the text. The text stays in the row, hidden from view, so search,
 * the accessible name, and the description a screen reader reads do not
 * change. The visual keeps the line's height.
 */
export function OptionDescription(props: {
  text?: string;
  visual?: () => JSX.Element;
  class?: string;
  id?: string;
  /** The text is why the option is unavailable: it shows as text, never as the visual. */
  reason?: boolean;
}): JSX.Element {
  return (
    <Show when={props.text || props.visual}>
      <small class={props.class} id={props.id} data-reason={props.reason ? "true" : undefined}>
        <Show when={!props.reason && props.visual} fallback={props.text}>
          {(visual) => (
            <>
              <span class="k2b-option-visual" aria-hidden="true">
                {visual()()}
              </span>
              <span class="k2b-sr-only">{props.text}</span>
            </>
          )}
        </Show>
      </small>
    </Show>
  );
}
