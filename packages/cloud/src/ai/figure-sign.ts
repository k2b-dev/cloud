/** A Tabler icon name as Gustav's card, chart and view tools take it, such as `wallet`. */
export const TABLER_ICON_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The sign of a key figure that names none: the same for every figure, never guessed from its value. */
export const NEUTRAL_FIGURE_SIGN = "ti ti-hash";

/**
 * The small sign before a key figure's label (v12 §9: "small sign and name"). Every key figure Gustav draws has one:
 * the Tabler icon it names, or the neutral sign when it names none or a name that is no Tabler icon name.
 */
export const figureSign = (name: unknown): string =>
  typeof name === "string" && TABLER_ICON_NAME.test(name) ? `ti ti-${name}` : NEUTRAL_FIGURE_SIGN;
