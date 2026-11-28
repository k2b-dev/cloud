import { createEffect, createSignal, type JSX, on, Show } from "solid-js";
import { cssColor } from "../internal/color";
import { useAvatarMessages } from "./avatar-messages";
import { personTint } from "./person-color";

export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

/**
 * A status ring around the avatar: `"success"` for an active state such as someone working on a task, or an explicit
 * color, for example a collaborator's cursor color.
 */
export type AvatarRing = "success" | { color: string };

/** `square` marks an agent or service account; people stay round. */
export type AvatarShape = "circle" | "square";

/** `person` tints initials and icons by name; `neutral` keeps them gray, such as for someone outside the team. */
export type AvatarTone = "person" | "neutral";

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
  tone?: AvatarTone;
  loading?: "eager" | "lazy";
  class?: string;
  style?: JSX.CSSProperties | string;
};

/** Letters of a script that joins its letters (Arabic and others). */
const JOINING = /[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Nko}\p{Script=Mongolian}\p{Script=Adlam}\p{Script=Mandaic}]/u;

const initialsFor = (name: string): string => {
  // a word without a letter or digit ("·", "—", "&", an emoji) is no part of a name
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word));
  if (parts.length === 0) return "?";
  const initial = (word: string | undefined) => word?.match(/[\p{L}\p{N}]/u)?.[0] ?? "";
  const signs = parts.length === 1 ? Array.from(parts[0] ?? "").slice(0, 2) : [initial(parts[0]), initial(parts.at(-1))];
  // a zero-width non-joiner keeps two joining letters (Arabic and others) from joining: each shows its isolated form
  return signs.join(signs.some((sign) => JOINING.test(sign)) ? "\u200C" : "").toUpperCase();
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
  // a ring in a colour of its own shows only when that colour is a colour
  const ringColor = () => (typeof props.ring === "object" ? cssColor(props.ring.color) : undefined);
  const ring = () =>
    props.ring === undefined ? undefined : typeof props.ring === "string" ? props.ring : ringColor() ? "color" : undefined;
  const style = (): JSX.CSSProperties | string | undefined => {
    const color = ringColor();
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
          data-tint={props.tone === "neutral" ? undefined : personTint(props.name)}
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
