import { Avatar, type AvatarProps } from "@k2b/ui";
import type { JSX } from "solid-js";

export type CloudAvatarProps = Omit<AvatarProps, "name" | "src"> & {
  username: string;
  userId?: string | null;
  avatarHash?: string | null;
};

const avatarSource = (userId?: string | null, avatarHash?: string | null): string | undefined => {
  if (!userId || !avatarHash) return undefined;
  return `/api/accounts/users/${encodeURIComponent(userId)}/avatar?rev=${encodeURIComponent(avatarHash)}`;
};

export function CloudAvatar(props: CloudAvatarProps): JSX.Element {
  return (
    <Avatar
      name={props.username}
      src={avatarSource(props.userId, props.avatarHash)}
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
