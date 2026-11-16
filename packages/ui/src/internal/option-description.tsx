import { createMemo, type JSX } from "solid-js";

type OptionLine = { description?: string; descriptionVisual?: () => JSX.Element };

/**
 * The second line of an option row, as a `<small>`, or nothing without a
 * description. With a `descriptionVisual`, such as a colored `Tag`, the visual
 * shows in place of the description. The text stays in the row, hidden from
 * view, so search, the accessible name, and the description a screen reader
 * reads do not change. The visual keeps the line's height.
 *
 * Every option list calls this one function, so each call stays small in the
 * islands that ship several lists. Only whether the line exists decides when
 * its element is made: a host that rebuilds equal options, such as a menu
 * whose entries come and go while someone types, keeps the element, and only
 * its content follows.
 */
export const optionDescription = (option: OptionLine | (() => OptionLine), className?: string, id?: string): JSX.Element => {
  const line = () => (typeof option === "function" ? option() : option);
  const shown = createMemo(() => !!line().description);
  // Read here, inside the caller's insert: it re-runs only when the line comes or goes.
  return (
    shown() && (
      <small class={className} id={id}>
        {line().descriptionVisual
          ? [
              <span class="k2b-option-visual" aria-hidden="true">
                {line().descriptionVisual?.()}
              </span>,
              <span class="k2b-sr-only">{line().description}</span>,
            ]
          : line().description}
      </small>
    )
  );
};
