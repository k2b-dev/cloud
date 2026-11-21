import { children, createUniqueId, type JSX, Show, splitProps } from "solid-js";
import { Dynamic } from "solid-js/web";
import { rendersSomething } from "../internal/renders-something";

export type RowGroupProps = Omit<JSX.HTMLAttributes<HTMLElement>, "children" | "title"> & {
  /** The value the rows share, such as a status, a tag, or a person. */
  title: JSX.Element;
  /** How many rows the group holds, after the title. */
  count?: number;
  /** At most one quiet control at the end of the head, such as "+". */
  action?: JSX.Element;
  /** The group's rows. A group without rows renders nothing. */
  children?: JSX.Element;
  /** Heading level of the title; defaults to 4. */
  level?: 3 | 4 | 5;
};

/**
 * A group (K17 "Gruppe"): a sort word for the rows of one list, such as tasks by status. A 36 px head on the page's
 * quiet ground with the name in 13 px bold, its count, and at most one action; the rows follow as they are. It
 * disappears when it is empty. A group never stands inside an `Area`.
 */
export function RowGroup(props: RowGroupProps): JSX.Element {
  const [local, rest] = splitProps(props, ["title", "count", "action", "children", "level", "class"]);
  const rows = children(() => local.children);
  const titleId = `k2b-row-group-${createUniqueId()}`;
  return (
    <Show when={rendersSomething(rows.toArray())}>
      <section {...rest} class={local.class ? `k2b-row-group ${local.class}` : "k2b-row-group"} aria-labelledby={titleId}>
        <div class="k2b-row-group__head">
          <Dynamic component={`h${local.level ?? 4}`} id={titleId} class="k2b-row-group__title">
            {local.title}
          </Dynamic>
          <Show when={local.count !== undefined}>
            <span class="k2b-row-group__count">{local.count}</span>
          </Show>
          <Show when={local.action}>
            <span class="k2b-row-group__action">{local.action}</span>
          </Show>
        </div>
        <div class="k2b-row-group__rows">{rows()}</div>
      </section>
    </Show>
  );
}

export default RowGroup;
