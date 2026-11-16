import { Link, type LinkNavigateEvent } from "@k2b/ssr/nav";
import { type JSX, Show } from "solid-js";
import { Paper } from "./Paper";

export type LinkCardColor = "blue" | "emerald" | "violet" | "orange" | "red" | "amber" | "zinc" | "cyan" | "rose";

export type LinkCardProps = {
  href: string;
  navigation?: "document" | "enhanced";
  onNavigate?: (event: LinkNavigateEvent) => void | Promise<void>;
  title: string;
  description: string;
  /** Tabler icon class of the icon tile. Omit it only together with `media`. */
  icon?: string;
  /** Replaces the icon tile, for example with a `FileTypeIcon` for a file. */
  media?: JSX.Element;
  /** Glyph color. Omit it to use the host application's accent. */
  color?: LinkCardColor;
  /** One trailing fact, such as a count or a badge. */
  meta?: JSX.Element;
  /**
   * `paper` (default) is a framed card. `plain` is a flat entry for a quiet overview: no frame and no surface until
   * hover, no chevron. Put plain cards in `AppOverview.Cards surface="plain"`.
   */
  surface?: "paper" | "plain";
  /**
   * The card as a small overview of one thing, as on "My apps & automations": `aside` stands top right beside the
   * title, such as a strip of the last runs; `body` is a line under the head, such as what it did last; `footer` is
   * the last line, `start` (a state with its sign) and `end` (a quiet time). Any of them stacks the card: head, body,
   * and footer one below the other, the footer on the card's bottom edge, a 10 px radius, and no chevron. Its title and
   * description wrap instead of ending in "…". The whole
   * card stays one link, so these places hold text and marks, never links or buttons.
   */
  aside?: JSX.Element;
  body?: JSX.Element;
  footer?: { start?: JSX.Element; end?: JSX.Element };
};

export function LinkCard(props: LinkCardProps): JSX.Element {
  const plain = () => props.surface === "plain";
  const stacked = () => Boolean(props.aside || props.body || props.footer);
  const content = (
    <>
      <Show
        when={props.media}
        fallback={
          <Show when={props.icon}>
            {(icon) => (
              <div class="k2b-link-card__icon k2b-icon-tile">
                <i class={`${icon()} k2b-link-card__glyph`} aria-hidden="true" />
              </div>
            )}
          </Show>
        }
      >
        <div class="k2b-link-card__media">{props.media}</div>
      </Show>
      <div class="k2b-link-card__copy">
        <span class="k2b-link-card__title">{props.title}</span>
        <p class="k2b-link-card__description">{props.description}</p>
      </div>
      <Show when={props.meta}>
        <span class="k2b-link-card__meta">{props.meta}</span>
      </Show>
      {/* One insertion for the chevron or every stacked place, so a classic card renders exactly as before. */}
      <Show
        when={stacked()}
        fallback={
          <Show when={!plain()}>
            <i class="ti ti-chevron-right k2b-link-card__chevron" aria-hidden="true" />
          </Show>
        }
      >
        <Show when={props.aside}>
          <span class="k2b-link-card__aside">{props.aside}</span>
        </Show>
        <Show when={props.body}>
          <span class="k2b-link-card__body">{props.body}</span>
        </Show>
        <Show when={props.footer}>
          {(footer) => (
            <span class="k2b-link-card__footer">
              <span class="k2b-link-card__footer-start">{footer().start}</span>
              <span class="k2b-link-card__footer-end">{footer().end}</span>
            </span>
          )}
        </Show>
      </Show>
    </>
  );
  if (props.navigation === "enhanced" && props.onNavigate) {
    return (
      <Link
        href={props.href}
        onNavigate={props.onNavigate}
        class={plain() ? "k2b-link-card" : "k2b-paper k2b-link-card"}
        data-color={props.color}
        data-surface={plain() ? "plain" : undefined}
        data-layout={stacked() ? "stacked" : undefined}
        data-interactive="true"
      >
        {content}
      </Link>
    );
  }
  if (plain())
    return (
      <a
        href={props.href}
        class="k2b-link-card"
        data-color={props.color}
        data-surface="plain"
        data-layout={stacked() ? "stacked" : undefined}
        data-interactive="true"
      >
        {content}
      </a>
    );
  return (
    <Paper
      as="a"
      href={props.href}
      class="k2b-link-card"
      data-color={props.color}
      data-layout={stacked() ? "stacked" : undefined}
      interactive
    >
      {content}
    </Paper>
  );
}

export default LinkCard;
