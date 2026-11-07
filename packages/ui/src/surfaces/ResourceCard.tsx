import { type JSX, Match, Show, Switch } from "solid-js";
import { useUiMessages } from "../intl/messages";
import type { LinkCardColor } from "./LinkCard";
import { useResourceMessages } from "./resource-messages";

/**
 * What a card can show of the element it stands for: the element itself, a placeholder while it is being looked up, or
 * why it cannot be shown.
 */
export type ResourceCardState = "ok" | "loading" | "no_access" | "deleted" | "unavailable";

/** The icon chip's colour, from the same palette as `LinkCard`. */
export type ResourceCardColor = LinkCardColor;

export type ResourceCardProps = {
  /** Defaults to `"ok"`. Every state has the same size, so a card that changes state moves nothing around it. */
  state?: ResourceCardState;
  /** The element's name. Shown only in state `"ok"`, as "Untitled" when blank, so a card that opens always has a name. */
  title?: string;
  /** Icon class of the element's kind, for example `ti ti-notebook`. Shown only in state `"ok"`. */
  icon?: string;
  /** Colour of the icon chip, usually one per kind of element. Without it the chip stays neutral. Only in state `"ok"`. */
  color?: ResourceCardColor;
  /** One line above the title: what and where the element is, for example "Task in IT planning · due 30 Oct". Only in state `"ok"`. */
  context?: string;
  /** The element's current state as a short label, for example "Open", shown at the end. Only in state `"ok"`. */
  status?: string;
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
const STATE_ICONS = { no_access: "ti ti-lock", deleted: "ti ti-trash", unavailable: "ti ti-cloud-off" } as const;

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
  const resourceMessages = useResourceMessages();
  const state = () => props.state ?? "ok";
  const ok = () => state() === "ok";
  const title = () => (props.title?.trim() ? props.title : resourceMessages().resourceUntitled);
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
        <span class={`k2b-resource-card__icon${props.color ? " k2b-icon-tile" : ""}`} aria-hidden="true">
          <i class={props.icon ?? DEFAULT_ICON} />
        </span>
        <span class="k2b-resource-card__copy">
          <Show when={props.context?.trim()}>
            <span class="k2b-resource-card__meta">{props.context}</span>
          </Show>
          <span class="k2b-resource-card__title">{title()}</span>
          <Show when={meta()}>
            <span class="k2b-resource-card__meta">{meta()}</span>
          </Show>
          <Show when={props.preview?.trim()}>
            <span class="k2b-resource-card__preview">{props.preview}</span>
          </Show>
        </span>
        <Show when={props.status?.trim()}>
          <span class="k2b-resource-card__status">{props.status}</span>
        </Show>
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
              <span class="k2b-resource-card__meta">{resourceMessages().resourceKind}</span>
              <span class="k2b-resource-card__label">
                {reason() === "no_access"
                  ? resourceMessages().resourceNoAccess
                  : reason() === "deleted"
                    ? resourceMessages().resourceDeleted
                    : resourceMessages().resourceUnavailable}
              </span>
              <Show when={reason() === "no_access"}>
                <span class="k2b-resource-card__meta">{resourceMessages().resourceNoAccessHint}</span>
              </Show>
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
            <div
              class={className()}
              data-state={state()}
              data-color={ok() ? props.color : undefined}
              aria-busy={state() === "loading" ? "true" : undefined}
            >
              {content()}
            </div>
          }
        >
          {(href) => (
            <a class={className()} data-state={state()} data-color={props.color} href={href()}>
              {content()}
            </a>
          )}
        </Show>
      }
    >
      {(open) => (
        <button type="button" class={className()} data-state={state()} data-color={props.color} onClick={() => open()()}>
          {content()}
        </button>
      )}
    </Show>
  );
}

export default ResourceCard;
