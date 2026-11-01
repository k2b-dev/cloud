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

/** The URL of a person's picture, or undefined while the person shows initials. */
export const cloudAvatarSource = avatarSource;

/**
 * Where an avatar's image comes from. A person has one only with a hash; a service account always has one, its photo
 * or its robot, so it is linked even without a hash and revalidates. A system actor has none.
 */
export const cloudAvatarImage = (params: {
  kind: CloudAvatarKind;
  userId?: string | null;
  avatarHash?: string | null;
}): string | undefined => {
  if (params.kind === "user") return avatarSource(params.userId, params.avatarHash);
  if (params.kind === "system" || !params.userId) return undefined;
  const rev = params.avatarHash ? `?rev=${encodeURIComponent(params.avatarHash)}` : "";
  return `/api/accounts/users/${encodeURIComponent(params.userId)}/avatar${rev}`;
};

const KIND_ICON: Record<CloudAvatarKind, string | undefined> = {
  user: undefined,
  service_account: "ti ti-robot",
  system: "ti ti-settings-automation",
};

/**
 * One avatar for every Cloud surface. A person shows a photo, a built avatar, or initials; a service account shows its
 * photo or robot in a square, with its icon only while the image cannot load.
 */
export function CloudAvatar(props: CloudAvatarProps): JSX.Element {
  const kind = () => props.kind ?? "user";
  return (
    <Avatar
      name={props.username}
      src={cloudAvatarImage({ kind: kind(), userId: props.userId, avatarHash: props.avatarHash })}
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
