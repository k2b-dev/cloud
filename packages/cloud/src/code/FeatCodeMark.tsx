import type { JSX } from "solid-js";

/** The brand name of Code. It is a name, so every locale shows and reads it the same. */
export const FEAT_CODE_NAME = "feat/code";

/**
 * Two drawings of one sign on a 26 × 31 box: the slash is a small commit graph, an origin commit (ring) and a new
 * commit (dot). At 16 px and below, the slim drawing reads as a needle, so the small drawing gives ring and dot the
 * same size and shortens the stroke.
 */
const LARGE = () => (
  <>
    <line class="cloud-featcode__new" x1="12" y1="22" x2="20" y2="10.5" stroke-width="3.5" />
    <circle class="cloud-featcode__base" cx="9.5" cy="25" r="4.25" stroke-width="3.5" />
    <circle class="cloud-featcode__head" cx="22.5" cy="7.5" r="5.5" />
  </>
);
const SMALL = () => (
  <>
    <line class="cloud-featcode__new" x1="13" y1="20" x2="20.2" y2="10.9" stroke-width="4.5" />
    <circle class="cloud-featcode__base" cx="10" cy="24" r="5" stroke-width="3.5" />
    <circle class="cloud-featcode__head" cx="22" cy="8.5" r="6.75" />
  </>
);

/** Sizes up to this many pixels use the small drawing. */
const SMALL_MAX_PX = 16;

export type FeatCodeMarkProps = {
  /** The word with the sign as its slash (default), or the sign alone, square, for icon slots. */
  variant?: "wordmark" | "glyph";
  /**
   * `text` (default) takes the surrounding text size with the small drawing, for running text, rows, and tabs.
   * `title` takes the surrounding size with the slim drawing, for headings. A number sets the font size of the
   * wordmark or the edge of the glyph in pixels; 16 and below use the small drawing.
   */
  size?: "text" | "title" | number;
  /** `brand` colours the new commit green; `current` draws everything in the text colour, as in tabs and menus. */
  tone?: "brand" | "current";
  /** Hides the mark from screen readers when visible text next to it already names Code. */
  decorative?: boolean;
  class?: string;
};

/** The feat/code brand: a wordmark or sign that never wraps and keeps its width in every state. */
export function FeatCodeMark(props: FeatCodeMarkProps): JSX.Element {
  const px = () => (typeof props.size === "number" ? props.size : undefined);
  const small = () => {
    const size = props.size ?? "text";
    return size === "text" || (typeof size === "number" && size <= SMALL_MAX_PX);
  };
  const glyph = () => props.variant === "glyph";
  const sign = () => (
    <svg
      class="cloud-featcode__sign"
      viewBox={glyph() ? "0.5 1 31 31" : "3 1 26 31"}
      aria-hidden="true"
      data-drawing={small() ? "small" : "large"}
    >
      {small() ? SMALL() : LARGE()}
    </svg>
  );
  return (
    <span
      class={`cloud-featcode${props.class ? ` ${props.class}` : ""}`}
      data-variant={glyph() ? "glyph" : "wordmark"}
      data-tone={props.tone ?? "brand"}
      style={px() === undefined ? undefined : { "font-size": `${px()}px` }}
      role="img"
      aria-label={props.decorative ? undefined : FEAT_CODE_NAME}
      aria-hidden={props.decorative ? "true" : undefined}
    >
      {glyph() ? (
        sign()
      ) : (
        <>
          <span class="cloud-featcode__word">feat</span>
          {sign()}
          <span class="cloud-featcode__word">code</span>
        </>
      )}
    </span>
  );
}
