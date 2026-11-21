import { type JSX, splitProps } from "solid-js";

export type FieldGridProps = Omit<JSX.HTMLAttributes<HTMLDivElement>, "children"> & {
  /** The fields of one row, such as `TextInput`s or `Select`s; each keeps its label, help, and error. */
  children: JSX.Element;
  /** How many fields stand side by side; defaults to 2. */
  columns?: 2 | 3 | 4;
};

/**
 * A row of fields on one grid (K5): every label row is 20 px, so the controls share their top edge, and help or an
 * error grows only its own field below the control. Below 360 px of width the fields stand one under the other, so a
 * label never runs into its neighbour (K15).
 */
export function FieldGrid(props: FieldGridProps): JSX.Element {
  const [local, rest] = splitProps(props, ["children", "columns", "class"]);
  return (
    <div {...rest} class={local.class ? `k2b-field-grid ${local.class}` : "k2b-field-grid"}>
      <div class="k2b-field-grid__row" data-columns={String(local.columns ?? 2)}>
        {local.children}
      </div>
    </div>
  );
}

export default FieldGrid;
