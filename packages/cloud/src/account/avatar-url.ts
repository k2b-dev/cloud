/** The URL of a person's picture, or undefined while the person shows initials. Free of JSX, so plain modules can use it. */
export const cloudAvatarSource = (userId?: string | null, avatarHash?: string | null): string | undefined => {
  if (!userId || !avatarHash) return undefined;
  return `/api/accounts/users/${encodeURIComponent(userId)}/avatar?rev=${encodeURIComponent(avatarHash)}`;
};
