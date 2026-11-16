import type { JSX } from "solid-js";

/**
 * The second line of an option row, as a `<small>`, or nothing without text
 * or visual. With a `descriptionVisual`, such as a colored `Tag`, the visual
 * shows in place of the description. The text stays in the row, hidden from
 * view, so search, the accessible name, and the description a screen reader
 * reads do not change. The visual keeps the line's height. A `reason`, why the
 * option is unavailable, always shows as text in place of both.
 *
 * A plain function that takes the option, not a component with one prop per
 * field: every option list calls it, and each call stays small in the islands
 * that ship several lists.
 */
export const optionDescription = (
  option: { description?: string; descriptionVisual?: () => JSX.Element },
  className?: string,
  id?: string,
  reason?: string,
): JSX.Element => {
  const text = reason || option.description;
  const visual = !reason && option.descriptionVisual;
  return (
    (text || visual) && (
      <small class={className} id={id} data-reason={reason ? "true" : undefined}>
        {visual
          ? [
              <span class="k2b-option-visual" aria-hidden="true">
                {visual()}
              </span>,
              <span class="k2b-sr-only">{text}</span>,
            ]
          : text}
      </small>
    )
  );
};
