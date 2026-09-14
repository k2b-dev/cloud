import { For, type JSX, Show } from "solid-js";

export type DescriptionListItem = {
  term: JSX.Element;
  description: JSX.Element;
  action?: JSX.Element;
};

export type DescriptionListProps = {
  items: readonly DescriptionListItem[];
  columns?: 1 | 2 | 3;
  layout?: "grid" | "rows" | "compact";
  size?: "sm" | "md";
  actionVisibility?: "always" | "progressive";
  class?: string;
};

/** Semantic key-value content with predictable responsive density. */
export function DescriptionList(props: DescriptionListProps): JSX.Element {
  const columns = () => Math.max(1, Math.min(3, props.columns ?? 1));
  return (
    <dl
      class={`k2b-description-list ${props.class ?? ""}`}
      data-columns={columns()}
      data-layout={props.layout ?? "grid"}
      data-size={props.size ?? "md"}
      data-action-visibility={props.actionVisibility ?? "always"}
    >
      <For each={props.items}>
        {(item) => (
          <div class="k2b-description-list__item">
            <dt>{item.term}</dt>
            <dd>{item.description}</dd>
            <Show when={item.action}>{(action) => <div class="k2b-description-list__action">{action()}</div>}</Show>
          </div>
        )}
      </For>
    </dl>
  );
}

export default DescriptionList;
