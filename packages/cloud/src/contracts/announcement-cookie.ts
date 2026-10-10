/**
 * The announcements cookie, without schemas: the shell reads and writes it on every page and must not load the
 * announcement validators for that. `AnnouncementCookieStateSchema` in `./announcements` describes the same shape.
 */
export const ANNOUNCEMENTS_COOKIE = "cloud_announcements";
export const ANNOUNCEMENTS_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
export const MAX_DISMISSED_BANNER_VERSIONS = 50;

export type AnnouncementCookieState = {
  seenAnnouncementVersion: number;
  dismissedBannerVersions: number[];
};

export const DEFAULT_ANNOUNCEMENT_COOKIE_STATE: AnnouncementCookieState = {
  seenAnnouncementVersion: 0,
  dismissedBannerVersions: [],
};

const isVersion = (value: unknown, minimum: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;

/** Any invalid field resets the whole state, as a failed schema parse did. */
const normalizeCookieState = (value: unknown): AnnouncementCookieState => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return DEFAULT_ANNOUNCEMENT_COOKIE_STATE;
  const { seenAnnouncementVersion = 0, dismissedBannerVersions = [] } = value as Partial<Record<keyof AnnouncementCookieState, unknown>>;
  if (!isVersion(seenAnnouncementVersion, 0)) return DEFAULT_ANNOUNCEMENT_COOKIE_STATE;
  if (!Array.isArray(dismissedBannerVersions) || !dismissedBannerVersions.every((version) => isVersion(version, 1)))
    return DEFAULT_ANNOUNCEMENT_COOKIE_STATE;
  const dismissed = [...new Set(dismissedBannerVersions)].sort((a, b) => b - a).slice(0, MAX_DISMISSED_BANNER_VERSIONS);

  return {
    seenAnnouncementVersion: Math.max(0, seenAnnouncementVersion),
    dismissedBannerVersions: dismissed,
  };
};

export const parseAnnouncementCookieValue = (value: string | null | undefined): AnnouncementCookieState => {
  if (!value) return DEFAULT_ANNOUNCEMENT_COOKIE_STATE;
  try {
    return normalizeCookieState(JSON.parse(decodeURIComponent(value)));
  } catch {
    return DEFAULT_ANNOUNCEMENT_COOKIE_STATE;
  }
};

export const parseAnnouncementCookieHeader = (cookieHeader: string | null | undefined): AnnouncementCookieState => {
  if (!cookieHeader) return DEFAULT_ANNOUNCEMENT_COOKIE_STATE;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${ANNOUNCEMENTS_COOKIE}=([^;]+)`));
  return parseAnnouncementCookieValue(match?.[1]);
};

export const serializeAnnouncementCookieState = (state: AnnouncementCookieState): string =>
  encodeURIComponent(JSON.stringify(normalizeCookieState(state)));

export const mergeAnnouncementCookieState = (
  current: AnnouncementCookieState,
  patch: Partial<AnnouncementCookieState>,
): AnnouncementCookieState =>
  normalizeCookieState({
    seenAnnouncementVersion: Math.max(current.seenAnnouncementVersion, patch.seenAnnouncementVersion ?? 0),
    dismissedBannerVersions: [...current.dismissedBannerVersions, ...(patch.dismissedBannerVersions ?? [])],
  });
