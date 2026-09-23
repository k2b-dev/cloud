import type { JSX } from "solid-js";
import type { PromptSearchInput, PromptSearchItem, PromptSearchOptions } from "../feedback/prompts";
import { prompts } from "../feedback/prompts";
import { resolveUiMessages, useUiMessages } from "../intl/messages";

export type SpotlightSearchResolver<T = unknown> = (input: PromptSearchInput) => Promise<PromptSearchItem<T>[]> | PromptSearchItem<T>[];

export type SpotlightSearchOptions<T = unknown> = PromptSearchOptions & {
  resolve: SpotlightSearchResolver<T>;
};

export type SpotlightButtonVariant = "default" | "compact" | "chip" | "sidebar" | "sidebar-mobile" | "icon";

export type SpotlightButtonProps = {
  variant?: SpotlightButtonVariant;
  label?: string;
  title?: string;
  icon?: string;
  shortcutLabel?: string | false;
  ariaLabel?: string;
  disabled?: boolean;
  class?: string;
  onClick: () => void | Promise<void>;
};

export const openSpotlightSearch = <T extends unknown = unknown>(
  options: SpotlightSearchOptions<T>,
): Promise<PromptSearchItem<T> | undefined> => {
  const { resolve, ...promptOptions } = options;
  const messages = resolveUiMessages();
  return prompts.search(resolve, {
    icon: "ti ti-search",
    placeholder: messages.search,
    minQueryLength: 0,
    noResultsText: messages.spotlightNoResults,
    size: "small",
    ...promptOptions,
  });
};

export function SpotlightButton(props: SpotlightButtonProps): JSX.Element {
  const messages = useUiMessages();
  const variant = () => props.variant ?? "default";
  const label = () => props.label ?? messages().searchLabel;
  const icon = () => props.icon ?? "ti ti-search";
  const shortcut = () => props.shortcutLabel;
  const title = () => props.title ?? label();
  const showsShortcut = () => Boolean(shortcut()) && ["chip", "sidebar"].includes(variant());

  return (
    <button
      type="button"
      class={`k2b-spotlight-button ${props.class ?? ""}`}
      data-variant={variant()}
      disabled={props.disabled}
      aria-label={props.ariaLabel ?? (["compact", "icon"].includes(variant()) ? label() : undefined)}
      title={title()}
      onClick={() => void props.onClick()}
    >
      <i class={icon()} aria-hidden="true" />
      <span class="k2b-spotlight-button__label">{label()}</span>
      {showsShortcut() && <kbd>{shortcut()}</kbd>}
    </button>
  );
}

export default SpotlightButton;
