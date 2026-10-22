import { Avatar, type AvatarProps } from "@k2b/ui";
import type { JSX } from "solid-js";

/** Who an avatar stands for; agents and service accounts are square, people round. */
export type CloudAvatarKind = "user" | "service_account" | "system";

export type CloudAvatarProps = Omit<AvatarProps, "name" | "src" | "shape" | "icon"> & {
  username: string;
  userId?: string | null;
  avatarHash?: string | null;
  kind?: CloudAvatarKind;
};

const avatarSource = (userId?: string | null, avatarHash?: string | null): string | undefined => {
  if (!userId || !avatarHash) return undefined;
  return `/api/accounts/users/${encodeURIComponent(userId)}/avatar?rev=${encodeURIComponent(avatarHash)}`;
};

/** The URL of a person's uploaded picture, or undefined when there is none. */
export const cloudAvatarSource = avatarSource;

const KIND_ICON: Record<CloudAvatarKind, string | undefined> = {
  user: undefined,
  service_account: "ti ti-robot",
  system: "ti ti-settings-automation",
};

/** One avatar for every Cloud surface: the uploaded picture when there is one, otherwise initials. */
export function CloudAvatar(props: CloudAvatarProps): JSX.Element {
  const kind = () => props.kind ?? "user";
  return (
    <Avatar
      name={props.username}
      src={kind() === "user" ? avatarSource(props.userId, props.avatarHash) : undefined}
      icon={KIND_ICON[kind()]}
      shape={kind() === "user" ? "circle" : "square"}
      alt={props.alt}
      fallback={props.fallback}
      size={props.size}
      ring={props.ring}
      loading={props.loading}
      class={props.class}
      style={props.style}
    />
  );
}
