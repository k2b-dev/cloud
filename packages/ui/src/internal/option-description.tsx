import type { JSX } from "solid-js";

/**
 * The second line of an option row, as a `<small>`, or nothing without text
 * or visual. With a `visual`, such as a colored `Tag`, the visual shows in
 * place of the text. The text stays in the row, hidden from view, so search,
 * the accessible name, and the description a screen reader reads do not
 * change. The visual keeps the line's height. A `reason`, why the option is
 * unavailable, always shows as text.
 *
 * A plain function, not a component: every option list calls it, and each
 * call stays small in the islands that ship several lists.
 */
export const optionDescription = (
  text: string | undefined,
  visual: (() => JSX.Element) | undefined,
  className?: string,
  id?: string,
  reason?: boolean,
): JSX.Element =>
  (text || visual) && (
    <small class={className} id={id} data-reason={reason ? "true" : undefined}>
      {visual && !reason
        ? [
            <span class="k2b-option-visual" aria-hidden="true">
              {visual()}
            </span>,
            <span class="k2b-sr-only">{text}</span>,
          ]
        : text}
    </small>
  );
