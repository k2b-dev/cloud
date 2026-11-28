/** The URL of a person's picture, or undefined while the person shows initials. Free of JSX, so plain modules can use it. */
export const cloudAvatarSource = (userId?: string | null, avatarHash?: string | null): string | undefined => {
  if (!userId || !avatarHash) return undefined;
  return `/api/accounts/users/${encodeURIComponent(userId)}/avatar?rev=${encodeURIComponent(avatarHash)}`;
};

/** Who an avatar stands for; agents and service accounts are square, people round. */
export type CloudAvatarKind = "user" | "service_account" | "system";

/**
 * Where an avatar's image comes from. A person has one only with a hash; a service account always has one, its photo
 * or its robot, so it is linked even without a hash and revalidates. A system actor has none.
 */
export const cloudAvatarImage = (params: {
  kind: CloudAvatarKind;
  userId?: string | null;
  avatarHash?: string | null;
}): string | undefined => {
  if (params.kind === "user") return cloudAvatarSource(params.userId, params.avatarHash);
  if (params.kind === "system" || !params.userId) return undefined;
  const rev = params.avatarHash ? `?rev=${encodeURIComponent(params.avatarHash)}` : "";
  return `/api/accounts/users/${encodeURIComponent(params.userId)}/avatar${rev}`;
};
