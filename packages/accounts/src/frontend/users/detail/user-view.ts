import type { PwaDeviceView } from "@k2b/cloud/contracts";
import type { linuxIdentities } from "@k2b/cloud/services";
import type { User } from "@/contracts";
import type { KeyPage } from "../../service-accounts/account-keys";
import { USERS_PAGE_PATH } from "../query";

/** Memberships one page of the groups tab lists; the next page is a link. */
export const GROUPS_PAGE = 100;

/** The page of the groups tab from the address (`?page=`), 1 when it names none or nonsense. */
export const groupsPageFrom = (value: string | undefined): number => {
  const page = Number(value);
  return Number.isInteger(page) && page > 1 && page <= 10_000 ? page : 1;
};

/** The areas of a user's record; each is a tab, named in the address as `?tab=`. */
export const USER_TABS = ["overview", "groups", "keys", "devices"] as const;
export type UserTab = (typeof USER_TABS)[number];

/**
 * The open tab from the address. `recursive=true` alone is an address from before the tabs, when the memberships stood
 * on the one page: it opens the groups, where that switch lives.
 */
export const userTabFrom = (tab: string | undefined, recursive: boolean): UserTab =>
  USER_TABS.find((entry) => entry === tab) ?? (recursive ? "groups" : "overview");

/**
 * A user's page: the list it was opened from (`list`, so back and the breadcrumb return to the same filtered list),
 * the tab, and whether the memberships include inherited groups. The overview is the default and stays out of it.
 */
export const userRecordHref = (
  id: string,
  list: string,
  open: { tab?: UserTab; recursive?: boolean; page?: number } = {},
): string => {
  const params = new URLSearchParams();
  if (list) params.set("list", list);
  if (open.tab && open.tab !== "overview") params.set("tab", open.tab);
  if (open.recursive) params.set("recursive", "true");
  if (open.page && open.page > 1) params.set("page", String(open.page));
  const query = params.toString();
  return `${USERS_PAGE_PATH}/${id}${query ? `?${query}` : ""}`;
};

/** A labelled value of the record, formatted on the server so the first paint and the live page agree. */
export type UserFact = {
  label: string;
  value: string;
  /** Read sign by sign (an ID): monospace, copyable. */
  mono?: boolean;
  copy?: boolean;
  /** No value: shown quiet. */
  missing?: boolean;
  /** The date has passed: shown as a warning. */
  overdue?: boolean;
};

export type UserGroupView = {
  id: string;
  name: string;
  description: string | null;
  provider: "ipa" | "local";
  /** A direct membership; an inherited one comes through another group and cannot be removed here. */
  direct: boolean;
};

export type UserSignInDeviceView = { id: string; name: string; assisted: boolean; paired: string; lastUsed: string | null };

export type UserAppDeviceView = { id: string; name: string; platform: PwaDeviceView["platform"]; paired: string; lastUsed: string };

export type LinuxSnapshot = Awaited<ReturnType<typeof linuxIdentities.get>>;

/** The overview: the account's facts, its direct groups, its Linux identity and its latest activity. */
export type OverviewArea = {
  tab: "overview";
  facts: UserFact[];
  sshFingerprints: string[];
  linux: LinuxSnapshot | null;
  /** The first direct groups; `directCount` counts all of them. */
  directGroups: UserGroupView[];
  directCount: number;
  /** The newest things done to the account, worded on the server; null when the log could not be read. */
  activity: { actor: string; actorImage?: string; action: string; when: string }[] | null;
};

/** The memberships: direct ones, or with `recursive` every group including inherited ones, and the managed groups. */
export type GroupsArea = {
  tab: "groups";
  /** One page of the memberships, `GROUPS_PAGE` at most; `total` counts all of them. */
  memberships: UserGroupView[];
  total: number;
  page: number;
  pages: number;
  /** The first page of the groups the person manages; `managedTotal` counts all of them. */
  managed: UserGroupView[];
  managedTotal: number;
};

/** The person's own API keys: the first page the key section pages on from. */
export type KeysArea = {
  tab: "keys";
  /** Null when it could not be read. */
  keys: KeyPage | null;
  /** Whether a key may be limited to AI models. */
  modelsAvailable: boolean;
  /** The reader's time zone: the key section's dates follow it. */
  timeZone: string;
};

/** The person's sign-in devices and Cloud app devices. */
export type DevicesArea = {
  tab: "devices";
  /** Null when they could not be loaded: an administrator must still see that a device may exist. */
  signInDevices: UserSignInDeviceView[] | null;
  appDevices: UserAppDeviceView[] | null;
  /** Where the sign-in app is paired for this person, when administrators may pair it for them. */
  signInPairHref: string | null;
  /** The name of this Cloud, as the Cloud app shows it. */
  cloud: string;
};

/**
 * What a user's page shows, as plain data from the server: the head and the deeds of the account on every tab, and
 * the data of the open tab only. A tab is a link, so another tab loads its own data on the server.
 */
export type UserRecordView = {
  user: User;
  /** Display name, else address, else UID. */
  title: string;
  image: string | undefined;
  /** The account's category and its extra roles, as words. */
  kinds: string[];
  expired: boolean;
  /** Where the account stands, as the user list says it: signed in, never signed in, or ended. */
  status: "active" | "invited" | "expired";
  /** The last Cloud sign-in, formatted; null when there was none. */
  lastSignIn: string | null;
  /** When it expired or expires, formatted; null when it never does. */
  expires: string | null;
  /** For pairing the Cloud app, which a reload or the way back from signing in may resume on any tab. */
  cloudApp: { blocked: boolean; administrator: string; name: string };
  freeIpaEnabled: boolean;
  localEmailOptional: boolean;
  area: OverviewArea | GroupsArea | KeysArea | DevicesArea;
};
