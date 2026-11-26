/**
 * The kinds of the activity page: one list, and the kind decides which entries it shows and which filters it has. Each
 * kind declares its own list query (in its directory); every declaration starts with the same required `kind` field,
 * so the kind is one statement in the filter bar ("Art ist Protokoll") and lives in the address as `kind=…`.
 */
import { field, type ListQueryOption } from "@k2b/ui/v2/list-query";
import { activityMessages } from "./messages";

export const ACTIVITY_PATH = "/app/accounts/activity";
/** A notification batch's own record. */
export const BATCH_PATH = `${ACTIVITY_PATH}/notifications`;

export const ACTIVITY_KINDS = ["audit", "notifications", "reminders", "deleted"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
/** The kind the page shows when the address names none. */
export const DEFAULT_KIND: ActivityKind = "audit";

/** The kind field every declaration of the page begins with: one kind at a time, always set, Protokoll by default. */
export const kindField = (locale: string) => {
  const { t } = activityMessages.resolve([locale]);
  return field.choice({
    label: t.kind,
    common: true,
    multiple: false,
    options: ACTIVITY_KINDS.map((kind) => ({ value: kind, label: t[kind] })) satisfies ListQueryOption<ActivityKind>[],
    required: DEFAULT_KIND as ActivityKind,
  });
};

/** The kind an address names; an unknown kind falls back to the default (its declaration reports the value). */
export const activityKindOf = (params: URLSearchParams): ActivityKind => {
  const kind = params.get("kind");
  return (ACTIVITY_KINDS as readonly string[]).includes(kind ?? "") ? (kind as ActivityKind) : DEFAULT_KIND;
};

/** The address of a kind with nothing else set: where switching the kind leads, so no filter of another kind stays. */
export const kindHref = (kind: ActivityKind): string => (kind === DEFAULT_KIND ? ACTIVITY_PATH : `${ACTIVITY_PATH}?kind=${kind}`);

/** The address of a list on the activity page: its query parameters, and the page parameters beside them. */
export const activityHref = (params: URLSearchParams): string => {
  const text = params.toString();
  return text ? `${ACTIVITY_PATH}?${text}` : ACTIVITY_PATH;
};

// As the lists' own addresses (`serialize`): `,` `:` `/` and `@` stay readable, every other sign stays encoded.
const readable = (params: URLSearchParams) => params.toString().replace(/%(?:2C|3A|2F|40)/gi, (escape) => decodeURIComponent(escape));

/**
 * The activity address for an address of one of the pages it replaced (`/audit`, `/notifications`, `/reminders`,
 * `/deleted-accounts`): the kind first, then every parameter carried over; only the search moved from `search` to `q`,
 * and a `q` that is already there wins.
 */
export const legacyListHref = (kind: ActivityKind, params: URLSearchParams): string => {
  const next = new URLSearchParams();
  if (kind !== DEFAULT_KIND) next.set("kind", kind);
  for (const [name, value] of params) if (name !== "search" && name !== "kind") next.append(name, value);
  const search = params.get("search")?.trim();
  if (search && !params.has("q")) next.set("q", search);
  const text = readable(next);
  return text ? `${ACTIVITY_PATH}?${text}` : ACTIVITY_PATH;
};
