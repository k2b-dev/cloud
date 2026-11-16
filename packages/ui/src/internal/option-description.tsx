import { type JSX, Show } from "solid-js";

/**
 * The second line of an option row. With a `visual`, such as a colored `Tag`,
 * the visual shows in place of the text. The text stays in the row, hidden
 * from view, so search, the accessible name, and the description a screen
 * reader reads do not change. The visual keeps the line's height.
 */
export function OptionDescription(props: { text?: string; visual?: () => JSX.Element }): JSX.Element {
  return (
    <Show when={props.visual} fallback={props.text}>
      {(visual) => (
        <>
          <span class="k2b-option-visual" aria-hidden="true">
            {visual()()}
          </span>
          <Show when={props.text}>{(text) => <span class="k2b-sr-only">{text()}</span>}</Show>
        </>
      )}
    </Show>
  );
}
