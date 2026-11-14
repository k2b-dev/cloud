import { For, type JSX, Show } from "solid-js";

/**
 * `add` gains something, `change` alters it, `remove` takes it away, `same` stays as it is, `neutral` names a
 * setting, `warning` has a consequence for others.
 */
export type ChangeTone = "add" | "change" | "remove" | "same" | "neutral" | "warning";

/** A short quiet word at the end of a line, such as "new", "dropped", or "needs approval". */
export type ChangeMark = {
  label: string;
  /** A Tabler icon class before the word. */
  icon?: string;
  /** `new` takes the action colour, `gone` an outline; `neutral`, the default, a quiet grey. */
  tone?: "new" | "gone" | "neutral";
};

export type ChangeListItem = {
  tone: ChangeTone;
  /** A Tabler icon class; defaults to plus, arrows or minus by tone. With `marker="sign"` the sign stays. */
  icon?: string;
  content: JSX.Element;
  /** One quiet line under the content, such as what the change means for others. */
  detail?: JSX.Element;
  /** Words at the end of the line, such as which change needs approval. */
  marks?: readonly ChangeMark[];
};

export type ChangeListProps = {
  items: readonly ChangeListItem[];
  /** Names the list for assistive technology, such as "What changes". */
  label: string;
  /**
   * `icon`, the default: a round icon chip per line, for pending edits beside a save action. `sign`: a bare sign on
   * one text edge, `+` in the action colour for something new, `−` for something gone, `=` for what stays, for a
   * comparison such as what a new version may do.
   */
  marker?: "icon" | "sign";
  class?: string;
};

const DEFAULT_ICONS: Record<ChangeTone, string> = {
  add: "ti ti-plus",
  change: "ti ti-arrows-exchange",
  remove: "ti ti-minus",
  same: "ti ti-equal",
  neutral: "ti ti-point",
  warning: "ti ti-alert-triangle",
};

/** Changes, one line each, so a person can check them in one look: pending edits, or what a new version changes. */
export function ChangeList(props: ChangeListProps): JSX.Element {
  const sign = () => props.marker === "sign";
  return (
    <ul class={`k2b-change-list ${props.class ?? ""}`} aria-label={props.label} data-marker={props.marker ?? "icon"}>
      <For each={props.items}>
        {(item) => (
          <li class="k2b-change-list__item" data-tone={item.tone}>
            <i
              class={`${sign() ? DEFAULT_ICONS[item.tone] : (item.icon ?? DEFAULT_ICONS[item.tone])} k2b-change-list__icon`}
              aria-hidden="true"
            />
            <span class="k2b-change-list__text">
              <span>
                {item.content}
                <For each={item.marks ?? []}>
                  {(mark) => (
                    <span class="k2b-change-list__mark" data-tone={mark.tone ?? "neutral"}>
                      <Show when={mark.icon}>
                        <i class={mark.icon} aria-hidden="true" />
                      </Show>
                      {mark.label}
                    </span>
                  )}
                </For>
              </span>
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
