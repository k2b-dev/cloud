import type { MailCollaborator, MailDropAssignees } from "../../service/collaboration";
import type { LocalTag } from "../../service/local-tags";
import type { MailFolderView } from "../../service/messages";
import type { MailListItem } from "../../service/workspace";
import { mailDropMessages } from "./mail-drop-messages";
import { buildVisibleMailFolderTree, flattenMailFolderTree } from "./mail-folder-tree";

/**
 * What a dragged conversation can be dropped on, as plain data: Mail names the targets, their rights and reasons, and
 * the shared drag surface draws and hit-tests them. Everything here comes from the workspace's first load, so a drag
 * makes no request before its drop.
 */

/** A level holds at most this many targets besides "Back", so every tile keeps its 64 px hit area. */
export const MAIL_DROP_LEVEL_SIZE = 12;
/** The first people and folders level: the most frequent ones, then "More". */
export const MAIL_DROP_FIRST_LEVEL_SIZE = 11;
/** Recently used folders a browser remembers per mailbox: one level's worth. */
const MAIL_DROP_RECENT_FOLDERS = MAIL_DROP_FIRST_LEVEL_SIZE;

export type MailDropAction =
  | { kind: "assign-me" }
  | { kind: "assign"; userId: string; name: string }
  /** The assignment search; a drop on "Assign to someone else" opens it, as does one on "Search more people". */
  | { kind: "choose-assignee" }
  | { kind: "move"; folderId: string; name: string }
  | { kind: "done" }
  | { kind: "tag"; tagId: string; name: string };

/** Where a level target leads after the pointer rests on it. Paths index the A–Z ranges level by level. */
export type MailDropLevel =
  | { kind: "root" }
  | { kind: "assign" }
  | { kind: "assign-more"; path: readonly number[] }
  | { kind: "folder" }
  | { kind: "folder-more"; path: readonly number[] }
  | { kind: "tag" };

export type MailDropVisual =
  | { kind: "icon"; icon: string }
  | { kind: "person"; person: Pick<MailCollaborator, "id" | "displayName" | "avatarHash"> }
  | { kind: "tag"; color: string };

export type MailDropTarget = {
  /** Stable within a level, for keys and tests. */
  id: string;
  label: string;
  /** A second line: why the target is locked, or what resting on it does. */
  description?: string;
  visual: MailDropVisual;
  /** Locked targets stay in place with their reason and never take a drop. */
  disabled?: boolean;
  /** Resting on the target opens this level. */
  level?: MailDropLevel;
  /** A drop on the target does this; a level target without one does nothing when dropped on. */
  action?: MailDropAction;
  /** "Back" leads to the previous level and is drawn apart from the targets. */
  back?: boolean;
};

export type MailDropView = {
  /** The level's heading above its targets; empty on the first level. */
  crumb: string;
  targets: MailDropTarget[];
};

export type MailDropContext = {
  locale: string;
  currentUserId: string | null;
  /** The dragged rows: every selected row when the drag started on one of them, else the one row. */
  items: readonly Pick<MailListItem, "conversationId" | "assigneeUserIds" | "activeFolderIds" | "workStatus" | "localTags">[];
  /** People who may assign get them; null hides both assignment targets. */
  assignees: MailDropAssignees | null;
  /** One person alone cannot hand anything over: assignment targets need someone else who can be assigned. */
  teamMailbox: boolean;
  folders: readonly MailFolderView[];
  folderName: (folder: MailFolderView) => string;
  tags: readonly LocalTag[];
  /** Folder IDs most recently dropped on in this mailbox, newest first. */
  recentFolderIds: readonly string[];
};

const every = <T>(items: readonly T[], test: (item: T) => boolean) => items.length > 0 && items.every(test);

/** A–Z groups of at most MAIL_DROP_LEVEL_SIZE entries, nested when there are more groups than one level holds. */
const ranges = <T>(sorted: readonly T[]): T[][] => {
  const size = sorted.length <= MAIL_DROP_LEVEL_SIZE ** 2 ? MAIL_DROP_LEVEL_SIZE : Math.ceil(sorted.length / MAIL_DROP_LEVEL_SIZE);
  const groups: T[][] = [];
  for (let start = 0; start < sorted.length; start += size) groups.push(sorted.slice(start, start + size));
  return groups;
};

/** The entries a range path leads to, or null when the path no longer fits the data. */
const atPath = <T>(sorted: readonly T[], path: readonly number[]): readonly T[] | null => {
  let current: readonly T[] = sorted;
  for (const index of path) {
    const group = ranges(current)[index];
    if (!group) return null;
    current = group;
  }
  return current;
};

const rangeLabel = <T>(group: readonly T[], name: (entry: T) => string) => {
  const first = name(group[0]!);
  const last = name(group.at(-1)!);
  return first === last ? first : `${first} – ${last}`;
};

const firstWord = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** The folders a conversation can move to, in the sidebar's order. */
export const mailDropFolders = (folders: readonly MailFolderView[]): MailFolderView[] =>
  flattenMailFolderTree(buildVisibleMailFolderTree(folders))
    .map(({ folder }) => folder)
    .filter((folder) => folder.selectable && folder.discoveryState === "active");

export const mailDropView = (level: MailDropLevel, context: MailDropContext): MailDropView => {
  const t = mailDropMessages.resolve([context.locale]).t;
  const items = context.items;
  const me = context.currentUserId;
  const assignable = context.assignees !== null && context.teamMailbox && me !== null;
  const back = (to: MailDropLevel): MailDropTarget => ({
    id: "back",
    label: t.back,
    visual: { kind: "icon", icon: "ti ti-arrow-left" },
    level: to,
    back: true,
  });

  if (level.kind === "root") {
    const targets: MailDropTarget[] = [];
    if (assignable) {
      const mine = every(items, (item) => item.assigneeUserIds.includes(me));
      targets.push(
        {
          id: "assign-me",
          label: t.assignToMe,
          description: mine ? t.alreadyYours : t.othersStay,
          visual: { kind: "icon", icon: "ti ti-user-plus" },
          disabled: mine,
          action: { kind: "assign-me" },
        },
        {
          id: "assign",
          label: t.assignOther,
          description: t.restBriefly,
          visual: { kind: "icon", icon: "ti ti-users" },
          level: { kind: "assign" },
          action: { kind: "choose-assignee" },
        },
      );
    }
    targets.push({
      id: "folder",
      label: t.moveToFolder,
      description: t.restBriefly,
      visual: { kind: "icon", icon: "ti ti-folder-symlink" },
      level: { kind: "folder" },
    });
    const done = every(items, (item) => item.workStatus === "done");
    targets.push({
      id: "done",
      label: t.markDone,
      ...(done ? { description: t.alreadyDone } : {}),
      visual: { kind: "icon", icon: "ti ti-check" },
      disabled: done,
      action: { kind: "done" },
    });
    if (context.tags.length > 0)
      targets.push({
        id: "tag",
        label: t.addTag,
        description: t.restBriefly,
        visual: { kind: "icon", icon: "ti ti-tags" },
        level: { kind: "tag" },
      });
    return { crumb: "", targets };
  }

  if (level.kind === "assign" || level.kind === "assign-more") {
    const others = (context.assignees?.people ?? []).filter((person) => person.id !== me);
    const person = (entry: MailCollaborator): MailDropTarget => {
      const all = every(items, (item) => item.assigneeUserIds.includes(entry.id));
      const some = items.some((item) => item.assigneeUserIds.includes(entry.id));
      return {
        id: `person:${entry.id}`,
        label: entry.displayName,
        ...(some ? { description: t.alreadyResponsible } : {}),
        visual: { kind: "person", person: entry },
        disabled: all,
        action: { kind: "assign", userId: entry.id, name: entry.displayName },
      };
    };
    const more = context.assignees?.more ?? false;
    const frequent = others.slice(0, MAIL_DROP_FIRST_LEVEL_SIZE);
    const rest = others.slice(MAIL_DROP_FIRST_LEVEL_SIZE).sort((a, b) => a.displayName.localeCompare(b.displayName, context.locale));
    const search: MailDropTarget = {
      id: "search",
      label: t.searchPeople,
      visual: { kind: "icon", icon: "ti ti-search" },
      action: { kind: "choose-assignee" },
    };
    if (level.kind === "assign") {
      const targets = [back({ kind: "root" }), ...frequent.map(person)];
      if (rest.length > 0)
        targets.push({
          id: "more",
          label: more ? t.morePeopleOpen : t.morePeople({ count: rest.length }),
          description: t.restBriefly,
          visual: { kind: "icon", icon: "ti ti-dots" },
          level: { kind: "assign-more", path: [] },
          action: { kind: "choose-assignee" },
        });
      return { crumb: t.assignFrequentCrumb, targets };
    }
    const group = atPath(rest, level.path);
    const up: MailDropLevel = level.path.length === 0 ? { kind: "assign" } : { kind: "assign-more", path: level.path.slice(0, -1) };
    if (!group) return { crumb: t.assignMoreCrumb, targets: [back({ kind: "assign" })] };
    if (group.length <= MAIL_DROP_LEVEL_SIZE)
      return {
        crumb:
          level.path.length === 0
            ? t.morePeopleCrumb
            : `${t.morePeopleCrumb} · ${rangeLabel(group, (entry) => firstWord(entry.displayName))}`,
        targets: [back(up), ...group.map(person), ...(more && level.path.length === 0 ? [search] : [])],
      };
    return {
      crumb: t.assignMoreCrumb,
      targets: [
        back(up),
        ...ranges(group).map((entries, index) => ({
          id: `range:${index}`,
          label: rangeLabel(entries, (entry) => firstWord(entry.displayName)),
          description: t.peopleCount({ count: entries.length }),
          visual: { kind: "icon", icon: "ti ti-abc" } as const,
          level: { kind: "assign-more", path: [...level.path, index] } as const,
        })),
        ...(more && level.path.length === 0 ? [search] : []),
      ],
    };
  }

  if (level.kind === "folder" || level.kind === "folder-more") {
    const folders = mailDropFolders(context.folders);
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const recent = context.recentFolderIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    const ordered = [...new Set([...recent, ...folders])];
    const folderTarget = (folder: MailFolderView): MailDropTarget => {
      const here = every(items, (item) => item.activeFolderIds.includes(folder.id));
      const name = context.folderName(folder);
      return {
        id: `folder:${folder.id}`,
        label: name,
        ...(here ? { description: t.alreadyHere } : {}),
        visual: { kind: "icon", icon: folder.role === "inbox" ? "ti ti-inbox" : "ti ti-folder" },
        disabled: here,
        action: { kind: "move", folderId: folder.id, name },
      };
    };
    const first = ordered.slice(0, MAIL_DROP_FIRST_LEVEL_SIZE);
    const rest = ordered
      .slice(MAIL_DROP_FIRST_LEVEL_SIZE)
      .sort((a, b) => context.folderName(a).localeCompare(context.folderName(b), context.locale));
    if (level.kind === "folder") {
      const targets = [back({ kind: "root" }), ...first.map(folderTarget)];
      if (rest.length > 0)
        targets.push({
          id: "more",
          label: t.moreFolders({ count: rest.length }),
          description: t.restBriefly,
          visual: { kind: "icon", icon: "ti ti-dots" },
          level: { kind: "folder-more", path: [] },
        });
      return { crumb: recent.length > 0 ? t.folderRecentCrumb : t.folderCrumb, targets };
    }
    const group = atPath(rest, level.path);
    const up: MailDropLevel = level.path.length === 0 ? { kind: "folder" } : { kind: "folder-more", path: level.path.slice(0, -1) };
    if (!group) return { crumb: t.folderMoreCrumb, targets: [back({ kind: "folder" })] };
    if (group.length <= MAIL_DROP_LEVEL_SIZE) return { crumb: t.folderMoreCrumb, targets: [back(up), ...group.map(folderTarget)] };
    return {
      crumb: t.folderMoreCrumb,
      targets: [
        back(up),
        ...ranges(group).map((entries, index) => ({
          id: `range:${index}`,
          label: rangeLabel(entries, context.folderName),
          description: t.folderCount({ count: entries.length }),
          visual: { kind: "icon", icon: "ti ti-abc" } as const,
          level: { kind: "folder-more", path: [...level.path, index] } as const,
        })),
      ],
    };
  }

  return {
    crumb: t.tagCrumb,
    targets: [
      back({ kind: "root" }),
      ...context.tags.map((tag): MailDropTarget => {
        const all = every(items, (item) => item.localTags.some((existing) => existing.id === tag.id));
        return {
          id: `tag:${tag.id}`,
          label: tag.name,
          ...(all ? { description: t.alreadyTagged } : {}),
          visual: { kind: "tag", color: tag.color },
          disabled: all,
          action: { kind: "tag", tagId: tag.id, name: tag.name },
        };
      }),
    ],
  };
};

// Recently used folders: a per-browser convenience that orders the folder level. It never decides what a drop does.
const recentKey = (mailboxId: string) => `k2b-mail-drop-folders:${mailboxId}`;

export const readMailDropRecentFolders = (mailboxId: string): string[] => {
  try {
    const value: unknown = JSON.parse(globalThis.localStorage?.getItem(recentKey(mailboxId)) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string").slice(0, MAIL_DROP_RECENT_FOLDERS) : [];
  } catch {
    return [];
  }
};

export const rememberMailDropFolder = (mailboxId: string, folderId: string): void => {
  try {
    const next = [folderId, ...readMailDropRecentFolders(mailboxId).filter((id) => id !== folderId)].slice(0, MAIL_DROP_RECENT_FOLDERS);
    globalThis.localStorage?.setItem(recentKey(mailboxId), JSON.stringify(next));
  } catch {
    // Storage may be unavailable; the folder level then keeps the sidebar's order.
  }
};
