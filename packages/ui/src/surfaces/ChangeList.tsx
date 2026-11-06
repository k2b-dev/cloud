import { For, type JSX, Show } from "solid-js";

/** `add` gains something, `change` alters it, `remove` takes it away, `neutral` names a setting. */
export type ChangeTone = "add" | "change" | "remove" | "neutral" | "warning";

export type ChangeListItem = {
  tone: ChangeTone;
  /** A Tabler icon class; defaults to plus, arrows or minus by tone. */
  icon?: string;
  content: JSX.Element;
  /** One quiet line under the content, such as what the change means for others. */
  detail?: JSX.Element;
};

export type ChangeListProps = {
  items: readonly ChangeListItem[];
  /** Names the list for assistive technology, such as "What changes". */
  label: string;
  class?: string;
};

const DEFAULT_ICONS: Record<ChangeTone, string> = {
  add: "ti ti-plus",
  change: "ti ti-arrows-exchange",
  remove: "ti ti-minus",
  neutral: "ti ti-point",
  warning: "ti ti-alert-triangle",
};

/** Pending changes before they are saved, one line each, so a person can check them in one look. */
export function ChangeList(props: ChangeListProps): JSX.Element {
  return (
    <ul class={`k2b-change-list ${props.class ?? ""}`} aria-label={props.label}>
      <For each={props.items}>
        {(item) => (
          <li class="k2b-change-list__item" data-tone={item.tone}>
            <i class={`${item.icon ?? DEFAULT_ICONS[item.tone]} k2b-change-list__icon`} aria-hidden="true" />
            <span class="k2b-change-list__text">
              <span>{item.content}</span>
              <Show when={item.detail}>
                <span class="k2b-change-list__detail">{item.detail}</span>
              </Show>
            </span>
          </li>
        )}
      </For>
    </ul>
  );
}

export default ChangeList;
