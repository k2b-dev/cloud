import { Avatar, type AvatarProps } from "@k2b/ui";
import type { JSX } from "solid-js";
import { type CloudAvatarKind, cloudAvatarImage, cloudAvatarSource } from "./avatar-url";

export { type CloudAvatarKind, cloudAvatarImage };

export type CloudAvatarProps = Omit<AvatarProps, "name" | "src" | "shape" | "icon"> & {
  username: string;
  userId?: string | null;
  avatarHash?: string | null;
  kind?: CloudAvatarKind;
};

const avatarSource = cloudAvatarSource;

export { cloudAvatarSource };

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
