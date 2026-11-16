import { type JSX, Show } from "solid-js";

type OptionLine = { description?: string; descriptionVisual?: () => JSX.Element };

/**
 * The second line of an option row, as a `<small>`, or nothing without text
 * or visual. With a `descriptionVisual`, such as a colored `Tag`, the visual
 * shows in place of the description. The text stays in the row, hidden from
 * view, so search, the accessible name, and the description a screen reader
 * reads do not change. The visual keeps the line's height. A `reason`, why the
 * option is unavailable, always shows as text in place of both.
 *
 * Every option list calls this one function, so each call stays small in the
 * islands that ship several lists. It reads the option only inside its own
 * `Show`: a host that rebuilds equal options, such as a menu whose entries
 * come and go while someone types, keeps the line's element and only its text
 * follows.
 */
export const optionDescription = (
  option: OptionLine | (() => OptionLine),
  className?: string,
  id?: () => string,
  reason?: () => string | undefined,
): JSX.Element => {
  const line = () => (typeof option === "function" ? option() : option);
  const text = () => reason?.() || line().description;
  const visual = () => !reason?.() && line().descriptionVisual;
  return (
    <Show when={text() || visual()}>
      <small class={className} id={id?.()} data-reason={reason?.() ? "true" : undefined}>
        <Show when={visual()} fallback={text()}>
          {(shown) => [
            <span class="k2b-option-visual" aria-hidden="true">
              {shown()()}
            </span>,
            <span class="k2b-sr-only">{text()}</span>,
          ]}
        </Show>
      </small>
    </Show>
  );
};
