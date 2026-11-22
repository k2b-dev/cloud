import { type JSX, Show, splitProps } from "solid-js";
import { Button } from "../actions/Button";

export type AlertCellTone = "danger" | "warning" | "info" | "neutral";

/** The one deed of an alert cell. Its label names what the button does ("Open sender settings"), never "OK". */
export type AlertCellAction = {
  label: string;
  onClick: () => void;
  icon?: string;
  disabled?: boolean;
};

export type AlertCellProps = Omit<JSX.HTMLAttributes<HTMLElement>, "title" | "children"> & {
  tone?: AlertCellTone;
  /** The sign before the text, a Tabler class; each tone has a default. */
  icon?: string;
  /** What is wrong, in one sentence. */
  title: JSX.Element;
  /** What follows from it or what a person can do, in quieter text. */
  detail?: JSX.Element;
  /** At most one button, and only when there is a deed; a cell that only informs has none. */
  action?: AlertCellAction;
};

const icons: Record<AlertCellTone, string> = {
  danger: "ti ti-alert-circle",
  warning: "ti ti-alert-triangle",
  info: "ti ti-info-circle",
  neutral: "ti ti-info-circle",
};

/**
 * Something that needs a person (Cloud flach, K10, K14): a band of its column, not a box in it. The tint fills the
 * whole cell from edge to edge, the sign stands on the column's text edge and the text after it, and the one button
 * names its deed. The container draws the line below it (`k2b-divided`), as for every band. Place it as a direct band of a column, a detail column, or a dialog,
 * never inside a padded container.
 */
export function AlertCell(props: AlertCellProps): JSX.Element {
  const [local, rest] = splitProps(props, ["tone", "icon", "title", "detail", "action", "class"]);
  const tone = () => local.tone ?? "warning";
  return (
    <section role={tone() === "danger" ? "alert" : "status"} {...rest} class={`k2b-alert-cell ${local.class ?? ""}`} data-tone={tone()}>
      <span class="k2b-alert-cell__sign" aria-hidden="true">
        <i class={local.icon ?? icons[tone()]} />
      </span>
      <p class="k2b-alert-cell__title">{local.title}</p>
      <Show when={local.detail}>
        <p class="k2b-alert-cell__detail">{local.detail}</p>
      </Show>
      <Show when={local.action}>
        {(action) => (
          <div class="k2b-alert-cell__action">
            <Button type="button" variant="secondary" size="sm" disabled={action().disabled} onClick={() => action().onClick()}>
              <Show when={action().icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>
              {action().label}
            </Button>
          </div>
        )}
      </Show>
    </section>
  );
}
