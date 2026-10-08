import { type JSX, Match, Show, Switch } from "solid-js";
import { useUiMessages } from "../intl/messages";

/**
 * What a card can show of the element it stands for: the element itself, a placeholder while it is being looked up, or
 * why it cannot be shown.
 */
export type ResourceCardState = "ok" | "loading" | "no-access" | "deleted" | "unavailable";

export type ResourceCardProps = {
  /** Defaults to `"ok"`. Every state has the same size, so a card that changes state moves nothing around it. */
  state?: ResourceCardState;
  /** The element's name. Shown only in state `"ok"`. */
  title?: string;
  /** Icon class of the element's kind, for example `ti ti-notebook`. Shown only in state `"ok"`. */
  icon?: string;
  /** What the element belongs to, for example the application or service. Shown only in state `"ok"`. */
  source?: string;
  /** Where the element lives within its source, for example a folder or a project. Shown only in state `"ok"`. */
  location?: string;
  /** One line of plain text from the element. Shown only in state `"ok"`. */
  preview?: string;
  /** Opens the element, for example in a panel. Takes precedence over `href`. Only in state `"ok"`. */
  onOpen?: () => void;
  /** Opens the element. Absolute `https` or `http`, or relative. Only in state `"ok"`. */
  href?: string;
  class?: string;
};

const DEFAULT_ICON = "ti ti-file";
const LINK_PROTOCOLS = new Set(["https:", "http:"]);
const STATE_ICONS = { "no-access": "ti ti-lock", deleted: "ti ti-trash", unavailable: "ti ti-cloud-off" } as const;

/** A link the card may open: absolute with an allowed scheme, or relative to the page. */
const linkUrl = (href: string | undefined): string | undefined => {
  if (!href) return undefined;
  try {
    return LINK_PROTOCOLS.has(new URL(href, "https://relative.invalid/").protocol) ? href : undefined;
  } catch {
    return undefined;
  }
};

/**
 * A card for an element that something refers to, such as a task or a document, with the same size in every state.
 * Outside state `"ok"`, it shows none of the element's fields and opens nothing, whatever the caller passes.
 */
export function ResourceCard(props: ResourceCardProps): JSX.Element {
  const messages = useUiMessages();
  const state = () => props.state ?? "ok";
  const ok = () => state() === "ok";
  const meta = () => [props.source, props.location].filter((part) => part?.trim()).join(" · ");
  /** Why the element cannot be shown, outside `"ok"` and `"loading"`. */
  const reason = (): Exclude<ResourceCardState, "ok" | "loading"> | undefined => {
    const current = state();
    return current === "ok" || current === "loading" ? undefined : current;
  };
  const className = () => `k2b-resource-card${props.class ? ` ${props.class}` : ""}`;

  const content = () => (
    <Switch>
      <Match when={ok()}>
        <span class="k2b-resource-card__icon" aria-hidden="true">
          <i class={props.icon ?? DEFAULT_ICON} />
        </span>
        <span class="k2b-resource-card__copy">
          <span class="k2b-resource-card__title">{props.title}</span>
          <Show when={meta()}>
            <span class="k2b-resource-card__meta">{meta()}</span>
          </Show>
          <Show when={props.preview?.trim()}>
            <span class="k2b-resource-card__preview">{props.preview}</span>
          </Show>
        </span>
      </Match>
      <Match when={state() === "loading"}>
        <span class="k2b-resource-card__icon" aria-hidden="true" />
        <span class="k2b-resource-card__copy">
          <span class="k2b-resource-card__bar" aria-hidden="true" />
          <span class="k2b-resource-card__bar" aria-hidden="true" />
          <span class="k2b-sr-only">{messages().loading}</span>
        </span>
      </Match>
      <Match when={reason()}>
        {(reason) => (
          <>
            <span class="k2b-resource-card__icon" aria-hidden="true">
              <i class={STATE_ICONS[reason()]} />
            </span>
            <span class="k2b-resource-card__copy">
              <span class="k2b-resource-card__label">
                {reason() === "no-access"
                  ? messages().resourceNoAccess
                  : reason() === "deleted"
                    ? messages().resourceDeleted
                    : messages().resourceUnavailable}
              </span>
            </span>
          </>
        )}
      </Match>
    </Switch>
  );

  return (
    <Show
      when={ok() && props.onOpen}
      fallback={
        <Show
          when={ok() && linkUrl(props.href)}
          fallback={
            <div class={className()} data-state={state()} aria-busy={state() === "loading" ? "true" : undefined}>
              {content()}
            </div>
          }
        >
          {(href) => (
            <a class={className()} data-state={state()} href={href()}>
              {content()}
            </a>
          )}
        </Show>
      }
    >
      {(open) => (
        <button type="button" class={className()} data-state={state()} onClick={() => open()()}>
          {content()}
        </button>
      )}
    </Show>
  );
}

export default ResourceCard;
