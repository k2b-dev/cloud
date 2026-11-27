import { createSignal, type JSX, children as resolveChildren, Show } from "solid-js";
import { useDisclosure } from "./behavior/disclosure";
import { Button } from "./button";
import { custom, Icon } from "./marks";
import { HeadActions } from "./structure";
import type { Action, TwoActions } from "./types";

export type GroupProps = {
  /** A Tabler icon before the title. */
  icon?: string;
  /** The data colour of the group's area. */
  color?: string;
  /** The title of the group, such as a number. */
  title: string;
  /** A quiet count after the title. */
  count?: number | string;
  /** A quiet line under the title; the head grows from 40 to 56 px. */
  meta?: JSX.Element;
  /** A state at the end of the head, such as `<Text weight="medium"><Icon name="gavel" /> Läuft</Text>` or an amount. */
  state?: JSX.Element;
  /** More deeds of the group behind one "…" button. (The menu opens with the behaviour layer.) */
  menu?: Action;
  /** At most two text buttons at the end of the head; more deeds go into `menu`. */
  actions?: TwoActions;
  /**
   * Starts as only the head with its result; the content is hidden, and the chevron at the end opens and closes it
   * (a button that says whether the group is open).
   */
  folded?: boolean;
  /** What belongs together: text, `Steps`, a small `Table`, `Facts`, rows; never another group. */
  children?: JSX.Element;
};

/**
 * The one framed group: what belongs together (a delivery, the items of one consignor, a thread). A square frame of
 * one hairline, a tinted head, and no line inside: entries are told apart by spacing alone. Never nested.
 */
export const Group = (props: GroupProps) => {
  // parts passed as JSX are made once and read from here
  const meta = resolveChildren(() => props.meta);
  const state = resolveChildren(() => props.state);
  // a folded group opens and closes in place; one that is not folded has no toggle
  const [open, setOpen] = createSignal(!props.folded);
  const fold = useDisclosure(() => ({ defaultOpen: !props.folded, onOpenChange: setOpen }));
  return (
    <section class="k2-group" data-k2-part="Group" aria-label={props.title} data-folded={props.folded && !open() ? "" : undefined}>
      <div class="k2-gh" data-meta={meta() !== undefined ? "" : undefined}>
        <Show when={props.icon} fallback={<span />}>
          {(name) => (
            <Show when={props.color} fallback={<Icon name={name()} />}>
              <span class="k2-stile" style={custom({ "--k2-c": props.color })}>
                <Icon name={name()} />
              </span>
            </Show>
          )}
        </Show>
        <span class="k2-gh-title">
          {props.title}
          <Show when={props.count !== undefined}>
            <span class="k2-gh-count">{props.count}</span>
          </Show>
        </span>
        <Show when={meta() !== undefined}>
          <span class="k2-gh-meta">{meta()}</span>
        </Show>
        <Show when={state() !== undefined || props.actions?.length || props.menu || props.folded}>
          <span class="k2-gh-end">
            {state()}
            <Show when={props.menu}>
              {(menu) => (
                <Button
                  variant="ghost"
                  icon={menu().icon ?? "dots"}
                  label={menu().label}
                  href={menu().href}
                  onNavigate={menu().onNavigate}
                  onClick={() => menu().onClick?.()}
                  disabled={menu().disabled}
                />
              )}
            </Show>
            <HeadActions actions={props.actions} />
            <Show when={props.folded}>
              <fold.Trigger
                class="k2-btn"
                data-k2-part="Button"
                data-variant="ghost"
                data-icon-only=""
                data-fold=""
                aria-label={props.title}
                title={props.title}
              >
                <Icon name="chevron-down" />
              </fold.Trigger>
            </Show>
          </span>
        </Show>
      </div>
      <Show when={props.folded} fallback={props.children}>
        <fold.Panel class="k2-group-body">{props.children}</fold.Panel>
      </Show>
    </section>
  );
};
