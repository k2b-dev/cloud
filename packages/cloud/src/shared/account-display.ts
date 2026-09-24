import type { UserProfile, UserProvider } from "../contracts/shared";

type AccountLike = {
  provider: UserProvider;
  profile: UserProfile;
};

type SupplementalRole = "admin" | "group-manager";

export const getAccountTypeLabel = (user: Pick<AccountLike, "profile">): string =>
  user.profile === "user" ? "Full account" : "Guest account";

export const getManagementLabel = (user: Pick<AccountLike, "provider">): string => (user.provider === "ipa" ? "FreeIPA" : "Local");

export const getSupplementalRoleLabel = (role: SupplementalRole): string => (role === "group-manager" ? "Group Manager" : "Admin");

const isGerman = (locale: string | null | undefined): boolean => locale?.toLowerCase().split(/[-_]/)[0] === "de";

/**
 * Display form of a group name for people. In German, the first letter of each
 * word separated by whitespace or a hyphen is capitalised (`buchhaltung` →
 * `Buchhaltung`); other locales get the name unchanged. Use it only for rendered
 * text: stored names, identifiers, URLs, search input, and API or JSON output
 * keep the original name.
 */
export const groupDisplayName = (name: string, locale: string | null | undefined): string =>
  isGerman(locale)
    ? name.replace(/(^|[\s-])(\p{L})/gu, (_, separator: string, letter: string) => separator + letter.toLocaleUpperCase("de"))
    : name;
