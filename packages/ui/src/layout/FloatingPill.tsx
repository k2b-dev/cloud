import type { JSX } from "solid-js";

export type FloatingPillProps = {
  /** Names the group for assistive technology, such as "Note views and actions". */
  label: string;
  /** Views and actions, usually small `IconButton`s or a `SegmentedControl`; `FloatingPill.Separator` parts them. */
  children: JSX.Element;
  class?: string;
};

type FloatingPillComponent = ((props: FloatingPillProps) => JSX.Element) & { Separator: () => JSX.Element };

/**
 * The floating pill of a reading column (K6, K16): views and actions of a column that has neither head nor status
 * row, such as a note. Place it as the first child of `AppWorkspace.Main width="reading"`. It stays at the column's
 * top end while the text scrolls below it, and takes no room from the text. It is a `k2b-pill`, so its look, size,
 * and round controls are the ones of every floating pill.
 */
const FloatingPill = ((props: FloatingPillProps) => (
  <div class={`k2b-pill k2b-floating-pill${props.class ? ` ${props.class}` : ""}`} role="group" aria-label={props.label}>
    {props.children}
  </div>
)) as FloatingPillComponent;

FloatingPill.Separator = () => <span class="k2b-floating-pill__separator" aria-hidden="true" />;

export { FloatingPill };
export default FloatingPill;
