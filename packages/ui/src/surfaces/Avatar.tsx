import { createEffect, createSignal, type JSX, on, Show } from "solid-js";
import { useAvatarMessages } from "./avatar-messages";

export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

/**
 * A status ring around the avatar: `"success"` for an active state such as someone working on a task, or an explicit
 * color, for example a collaborator's cursor color.
 */
export type AvatarRing = "success" | { color: string };

/** `square` marks an agent or service account; people stay round. */
export type AvatarShape = "circle" | "square";

export type AvatarProps = {
  name: string;
  src?: string | null;
  icon?: string;
  alt?: string;
  fallback?: string;
  size?: AvatarSize;
  /** Draws a ring with a small transparent gap inside the avatar's own box, so the avatar keeps its size and no container clips the ring. */
  ring?: AvatarRing;
  shape?: AvatarShape;
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
  const avatarMessages = useAvatarMessages();
  const [failed, setFailed] = createSignal(false);
  const label = () => props.name.trim() || avatarMessages().unknownUser;
  // Derive initials from the given name, not from the accessible-name fallback:
  // an empty `name` must render "?" the way Cloud's avatar does, not "UU".
  const fallback = () => props.fallback ?? initialsFor(props.name);
  const fallbackContent = () => (props.icon ? <i class={props.icon} aria-hidden="true" /> : fallback());
  const className = () => `k2b-avatar ${props.class ?? ""}`;
  const ring = () => (props.ring === undefined ? undefined : typeof props.ring === "string" ? props.ring : "color");
  const style = (): JSX.CSSProperties | string | undefined => {
    const color = typeof props.ring === "object" ? props.ring.color : undefined;
    if (color === undefined) return props.style;
    if (typeof props.style === "string") return `${props.style ? `${props.style};` : ""}--k2b-avatar-ring:${color}`;
    return { ...props.style, "--k2b-avatar-ring": color };
  };

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
          data-shape={props.shape === "square" ? "square" : undefined}
          data-tint={tintFor(props.name.trim())}
          data-ring={ring()}
          style={style()}
          role="img"
          aria-label={props.alt ?? avatarMessages().avatarLabel({ name: label() })}
        >
          {fallbackContent()}
        </span>
      }
    >
      {(src) => (
        <img
          src={src()}
          alt={props.alt ?? avatarMessages().avatarLabel({ name: label() })}
          class={className()}
          data-size={props.size ?? "md"}
          data-shape={props.shape === "square" ? "square" : undefined}
          data-ring={ring()}
          style={style()}
          loading={props.loading ?? "lazy"}
          decoding="async"
          onError={() => setFailed(true)}
        />
      )}
    </Show>
  );
}
