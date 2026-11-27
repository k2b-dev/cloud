import { defineListQuery, field, type ListQueryStateOf, type LookupItem } from "@k2b/ui/v2/list-query";
import type { HistoryAction } from "../activity-contracts";
import type { HistoryMessages } from "./history-messages";
import type { ActivityWhen } from "./history-requests";

/** The changes Activity can be narrowed to, in the order "What" offers them. */
export const ACTIVITY_WHAT: readonly HistoryAction[] = [
  "folder.create",
  "file.upload",
  "file.overwrite",
  "file.edit",
  "item.rename",
  "item.move",
  "item.copy",
  "item.trash",
  "item.restore",
  "item.purge",
  "version.restore",
  "share.create",
  "share.revoke",
  "item.differs",
  "item.missing",
];
const WHEN: readonly ActivityWhen[] = ["today", "7", "30", "365"];

export const whatLabel = (t: HistoryMessages, action: HistoryAction) =>
  ({
    "folder.create": t.whatCreated,
    "file.upload": t.whatUploaded,
    "file.overwrite": t.whatOverwritten,
    "file.edit": t.whatEdited,
    "item.rename": t.whatRenamed,
    "item.move": t.whatMoved,
    "item.copy": t.whatCopied,
    "item.trash": t.whatTrashed,
    "item.restore": t.whatRestored,
    "item.purge": t.whatPurged,
    "version.restore": t.whatVersionRestored,
    "share.create": t.whatShareCreated,
    "share.revoke": t.whatShareRevoked,
    "item.differs": t.whatDiffers,
    "item.missing": t.whatMissing,
  })[action as string] ?? action;
const whenLabel = (t: HistoryMessages, when: ActivityWhen) =>
  ({ today: t.whenToday, "7": t.when7, "30": t.when30, "365": t.when365 })[when];

/**
 * The people Activity offers under "Who": "Me" first, then the people this person has seen act in Activity. Files has
 * no directory of people; the server resolves the chosen one by its ID.
 */
export type ActivityPeople = () => readonly LookupItem[];

/**
 * The filters of Activity as a list query, on the parameters Activity always had (`who`, `base`, `what`, `when`, `q`;
 * `view=activity` is the page). The item (`path` with its `scope`) belongs to the page. The order is fixed: the newest
 * change first. The address stays the authority: `parseActivityFilters` reads it for the request.
 */
export const activityQuery = (t: HistoryMessages, bases: readonly { id: string; label: string }[], people: ActivityPeople) => {
  const named = (values: readonly string[]) =>
    values.map(
      (value) => people().find((person) => person.value === value) ?? { value, label: value === "me" ? t.whoMe : t.selectedPerson },
    );
  return defineListQuery({
    key: "filesv2-activity",
    fields: {
      who: field.lookup({
        label: t.filterWho,
        multiple: false,
        common: true,
        load: async (text, { limit }) => {
          const words = text.trim().toLocaleLowerCase();
          return {
            items: people()
              .filter((person) => person.label.toLocaleLowerCase().includes(words))
              .slice(0, limit),
          };
        },
        resolve: async (values) => named(values),
      }),
      base: field.choice({
        label: t.filterBase,
        multiple: false,
        common: true,
        options: bases.map((base) => ({ value: base.id, label: base.label })),
      }),
      what: field.choice({
        label: t.filterWhat,
        multiple: false,
        common: true,
        options: ACTIVITY_WHAT.map((action) => ({ value: action, label: whatLabel(t, action) })),
      }),
      when: field.choice({
        label: t.filterWhen,
        multiple: false,
        common: true,
        options: WHEN.map((when) => ({ value: when, label: whenLabel(t, when) })),
      }),
    },
    search: { label: t.searchLabel },
    sort: { fixed: { field: "time", direction: "desc", label: t.newestFirst } },
    // an item stands in the head's path, where it is also taken away; the bar keeps it beside its filters
    pageParams: ["path", "scope"],
  });
};
export type ActivityQuery = ReturnType<typeof activityQuery>;
export type ActivityListState = ListQueryStateOf<ActivityQuery>;
