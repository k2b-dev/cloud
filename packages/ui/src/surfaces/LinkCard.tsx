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
  icon: string;
  /** Glyph color. Omit it to use the host application's accent. */
  color?: LinkCardColor;
  /** One trailing fact, such as a count or a badge. */
  meta?: JSX.Element;
};

export function LinkCard(props: LinkCardProps): JSX.Element {
  const content = (
    <>
      <div class="k2b-link-card__icon">
        <i class={`${props.icon} k2b-link-card__glyph`} aria-hidden="true" />
      </div>
      <div class="k2b-link-card__copy">
        <span class="k2b-link-card__title">{props.title}</span>
        <p class="k2b-link-card__description">{props.description}</p>
      </div>
      <Show when={props.meta}>
        <span class="k2b-link-card__meta">{props.meta}</span>
      </Show>
      <i class="ti ti-chevron-right k2b-link-card__chevron" aria-hidden="true" />
    </>
  );
  if (props.navigation === "enhanced" && props.onNavigate) {
    return (
      <Link
        href={props.href}
        onNavigate={props.onNavigate}
        class="k2b-paper k2b-link-card"
        data-color={props.color}
        data-interactive="true"
      >
        {content}
      </Link>
    );
  }
  return (
    <Paper as="a" href={props.href} class="k2b-link-card" data-color={props.color} interactive>
      {content}
    </Paper>
  );
}

export default LinkCard;
