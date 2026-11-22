import { createUniqueId, For, type JSX, Show, splitProps } from "solid-js";
import { Dynamic } from "solid-js/web";
import { IconButton } from "../actions/Button";
import { CopyButton } from "../actions/CopyButton";
import { useFlatBlockMessages } from "./flat-block-messages";
import { useSectionMessages } from "./section-messages";

/** One fact: a quiet label and a strong value. */
export type FactGroupItem = {
  label: string;
  value: JSX.Element;
  /** A quiet 12 px line under the value, such as "Default" or "since 6 Oct 2026". */
  detail?: JSX.Element;
  /**
   * Shows a copy button for a value people carry elsewhere: a phone number, an email, an address, an IBAN, a code.
   * `true` copies a text `value`; a string copies that string.
   */
  copy?: boolean | string;
};

export type FactGroupProps = Omit<JSX.HTMLAttributes<HTMLElement>, "children" | "title"> & {
  /** The group's name, such as "Contact" or "Bank". */
  title: string;
  /** A Tabler icon class before the title. */
  icon?: string;
  /** Two or more facts; a group of one value belongs into another group. A list (people) counts as a list. */
  items: readonly FactGroupItem[];
  /** The group's one pencil. It replaces "Edit" links on single values. */
  onEdit?: () => void;
  /** Heading level of the title; defaults to 3. */
  level?: 3 | 4;
};

/**
 * A group of facts (K17 "Angaben-Gruppe"), quiet and at hand: a title with its symbol and one pencil, then label and
 * value in two columns, label 12 px grey and value 13 px dark, with a copy button at values people carry elsewhere.
 * Groups stand apart by space, without lines. Below 360 px of width the label stands above its value, so a number or
 * an address keeps its line. Put the groups into a column of at most 400 px beside the detail column, or into it.
 */
export function FactGroup(props: FactGroupProps): JSX.Element {
  const [local, rest] = splitProps(props, ["title", "icon", "items", "onEdit", "level", "class"]);
  const t = useFlatBlockMessages();
  const copyLabel = useSectionMessages();
  const titleId = `k2b-fact-group-${createUniqueId()}`;
  const copyValue = (item: FactGroupItem) =>
    typeof item.copy === "string" ? item.copy : item.copy && typeof item.value === "string" ? item.value : undefined;
  return (
    <section
      {...rest}
      class={local.class ? `k2b-fact-group ${local.class}` : "k2b-fact-group"}
      aria-labelledby={titleId}
      data-k2b-band="topic"
    >
      <div class="k2b-fact-group__head">
        <Show when={local.icon}>{(icon) => <i class={`${icon()} k2b-fact-group__icon`} aria-hidden="true" />}</Show>
        <Dynamic component={`h${local.level ?? 3}`} id={titleId} class="k2b-fact-group__title">
          {local.title}
        </Dynamic>
        <Show when={local.onEdit}>
          {(edit) => (
            <IconButton
              size="sm"
              variant="ghost"
              class="k2b-fact-group__edit"
              label={t().editFacts({ title: local.title })}
              onClick={() => edit()()}
            >
              <i class="ti ti-pencil" aria-hidden="true" />
            </IconButton>
          )}
        </Show>
      </div>
      <dl class="k2b-fact-group__facts">
        <For each={local.items}>
          {(item) => (
            <div class="k2b-fact-group__fact">
              <dt>{item.label}</dt>
              <dd>
                <span class="k2b-fact-group__value">{item.value}</span>
                <Show when={item.detail}>
                  <small class="k2b-fact-group__detail">{item.detail}</small>
                </Show>
                {/* Inside the value, so the list holds only terms and values; without a copy button the slot stays, so
                    every value of a group ends on one edge. */}
                <Show when={copyValue(item)} fallback={<span class="k2b-fact-group__slot" aria-hidden="true" />}>
                  {(value) => (
                    <CopyButton
                      class="k2b-fact-group__copy"
                      value={value()}
                      size="xs"
                      iconOnly
                      label={copyLabel().copyField({ label: item.label })}
                    />
                  )}
                </Show>
              </dd>
            </div>
          )}
        </For>
      </dl>
    </section>
  );
}

export default FactGroup;
