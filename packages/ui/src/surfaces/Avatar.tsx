import { createEffect, createSignal, type JSX, on, Show } from "solid-js";
import { useUiMessages } from "../intl/messages";

export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

export type AvatarProps = {
  name: string;
  src?: string | null;
  icon?: string;
  alt?: string;
  fallback?: string;
  size?: AvatarSize;
  loading?: "eager" | "lazy";
  class?: string;
  style?: JSX.CSSProperties | string;
};

const initialsFor = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]?.slice(0, 2).toUpperCase() ?? "?";
  return `${parts[0]?.[0] ?? ""}${parts.at(-1)?.[0] ?? ""}`.toUpperCase();
};

/** Tints behind initials, as many as `.k2b-avatar[data-tint]` rules in the stylesheet. */
const TINTS = 10;

/**
 * The tint behind initials and icons, from the name, so the same name has one color wherever an avatar shows it. The
 * hash is the one of `@k2b/stdlib`'s generated avatar.
 */
const tintFor = (name: string): number => {
  let hash = 0;
  for (let index = 0; index < name.length; index++) hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  return hash % TINTS;
};

export function Avatar(props: AvatarProps): JSX.Element {
  const messages = useUiMessages();
  const [failed, setFailed] = createSignal(false);
  const label = () => props.name.trim() || messages().unknownUser;
  // Derive initials from the given name, not from the accessible-name fallback:
  // an empty `name` must render "?" the way Cloud's avatar does, not "UU".
  const fallback = () => props.fallback ?? initialsFor(props.name);
  const fallbackContent = () => (props.icon ? <i class={props.icon} aria-hidden="true" /> : fallback());
  const className = () => `k2b-avatar ${props.class ?? ""}`;

  createEffect(
    on(
      () => props.src,
      () => setFailed(false),
      { defer: true },
    ),
  );

  return (
    <Show
      when={!failed() ? props.src || undefined : undefined}
      fallback={
        <span
          class={className()}
          data-size={props.size ?? "md"}
          data-tint={tintFor(props.name.trim())}
          style={props.style}
          role="img"
          aria-label={props.alt ?? messages().avatarLabel({ name: label() })}
        >
          {fallbackContent()}
        </span>
      }
    >
      {(src) => (
        <img
          src={src()}
          alt={props.alt ?? messages().avatarLabel({ name: label() })}
          class={className()}
          data-size={props.size ?? "md"}
          style={props.style}
          loading={props.loading ?? "lazy"}
          decoding="async"
          onError={() => setFailed(true)}
        />
      )}
    </Show>
  );
}
