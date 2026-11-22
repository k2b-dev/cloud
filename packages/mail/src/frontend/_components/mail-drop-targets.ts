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

/** The type a dragged conversation row carries; the drop surface and the sidebar's folders take it. */
export const MAIL_CONVERSATION_DRAG = "mail.conversation";

/** The first people and folders level of the drop surface: the most frequent ones, then "More" (S7). */
export const MAIL_DROP_FIRST_LEVEL_SIZE = 11;
/** Recently used folders a browser remembers per mailbox: one level's worth. */
const MAIL_DROP_RECENT_FOLDERS = MAIL_DROP_FIRST_LEVEL_SIZE;

export type MailDropAction =
  | { kind: "assign-me" }
  | { kind: "assign"; userId: string; name: string }
  /** The assignment search; a drop on "Assign to someone else" opens it, as does one on "Search for someone". */
  | { kind: "choose-assignee" }
  | { kind: "move"; folderId: string; name: string }
  | { kind: "done" }
  | { kind: "tag"; tagId: string; name: string };

/** The levels a first-level target opens after resting on it; the drop surface splits long ones into pages. */
export type MailDropLevel = "assign" | "folder" | "tag";

export type MailDropVisual =
  | { kind: "icon"; icon: string }
  | { kind: "person"; person: Pick<MailCollaborator, "id" | "displayName" | "avatarHash"> }
  | { kind: "tag"; color: string };

export type MailDropTarget = {
  /** Stable within a level, for keys and tests. */
  id: string;
  label: string;
  /** A second line: why the target is locked, or what it does. */
  description?: string;
  visual: MailDropVisual;
  /** Locked targets stay in place with their reason and never take a drop. */
  disabled?: boolean;
  /** Resting on the target opens this level. */
  level?: MailDropLevel;
  /** A drop on the target does this; a level target without one does nothing when dropped on. */
  action?: MailDropAction;
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
const assignable = (context: MailDropContext) => context.assignees !== null && context.teamMailbox && context.currentUserId !== null;

/**
 * The rows a drag carries, found by the dragged row's own ID: in a message list, rows of one conversation can sit in
 * different folders, so a drop moves exactly that row. A row of a selection carries every selected row.
 */
export const mailDraggedRows = <Row extends Pick<MailListItem, "id" | "conversationId">>(
  rows: readonly Row[],
  selectedConversationIds: ReadonlySet<string>,
  rowId: string,
): Row[] => {
  const row = rows.find((candidate) => candidate.id === rowId);
  if (!row) return [];
  if (!row.conversationId || !selectedConversationIds.has(row.conversationId)) return [row];
  return rows.filter((candidate) => candidate.conversationId && selectedConversationIds.has(candidate.conversationId));
};

/** The folders a conversation can move to, in the sidebar's order. */
export const mailDropFolders = (folders: readonly MailFolderView[]): MailFolderView[] =>
  flattenMailFolderTree(buildVisibleMailFolderTree(folders))
    .map(({ folder }) => folder)
    .filter((folder) => folder.selectable && folder.discoveryState === "active");

/** The first level: assign to me, to someone else, move to a folder, mark as done, add a tag. */
export const mailDropRoot = (context: MailDropContext): MailDropTarget[] => {
  const t = mailDropMessages.resolve([context.locale]).t;
  const me = context.currentUserId;
  const targets: MailDropTarget[] = [];
  if (assignable(context) && me) {
    const mine = every(context.items, (item) => item.assigneeUserIds.includes(me));
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
        visual: { kind: "icon", icon: "ti ti-users" },
        level: "assign",
        action: { kind: "choose-assignee" },
      },
    );
  }
  targets.push({ id: "folder", label: t.moveToFolder, visual: { kind: "icon", icon: "ti ti-folder-symlink" }, level: "folder" });
  const done = every(context.items, (item) => item.workStatus === "done");
  targets.push({
    id: "done",
    label: t.markDone,
    ...(done ? { description: t.alreadyDone } : {}),
    visual: { kind: "icon", icon: "ti ti-check" },
    disabled: done,
    action: { kind: "done" },
  });
  if (context.tags.length > 0) targets.push({ id: "tag", label: t.addTag, visual: { kind: "icon", icon: "ti ti-tags" }, level: "tag" });
  return targets;
};

/**
 * The people to assign to, without the dragging person: the most frequent first, as the server orders them, then the
 * rest A–Z, so the surface's first page holds the frequent ones. `more` says the search knows more people than these.
 */
export const mailDropPeople = (context: MailDropContext): { targets: MailDropTarget[]; more: boolean } => {
  if (!assignable(context)) return { targets: [], more: false };
  const t = mailDropMessages.resolve([context.locale]).t;
  const others = (context.assignees?.people ?? []).filter((person) => person.id !== context.currentUserId);
  const ordered = [
    ...others.slice(0, MAIL_DROP_FIRST_LEVEL_SIZE),
    ...others.slice(MAIL_DROP_FIRST_LEVEL_SIZE).sort((a, b) => a.displayName.localeCompare(b.displayName, context.locale)),
  ];
  return {
    more: context.assignees?.more ?? false,
    targets: ordered.map((person) => {
      const all = every(context.items, (item) => item.assigneeUserIds.includes(person.id));
      const some = context.items.some((item) => item.assigneeUserIds.includes(person.id));
      return {
        id: `person:${person.id}`,
        label: person.displayName,
        ...(some ? { description: t.alreadyResponsible } : {}),
        visual: { kind: "person", person },
        disabled: all,
        action: { kind: "assign", userId: person.id, name: person.displayName },
      };
    }),
  };
};

/** The folders to move to: recently used ones first, then the sidebar's order, the rest after the first page A–Z. */
export const mailDropFolderTargets = (context: MailDropContext): MailDropTarget[] => {
  const t = mailDropMessages.resolve([context.locale]).t;
  const folders = mailDropFolders(context.folders);
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const recent = context.recentFolderIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  const ordered = [...new Set([...recent, ...folders])];
  return [
    ...ordered.slice(0, MAIL_DROP_FIRST_LEVEL_SIZE),
    ...ordered.slice(MAIL_DROP_FIRST_LEVEL_SIZE).sort((a, b) => context.folderName(a).localeCompare(context.folderName(b), context.locale)),
  ].map((folder) => {
    const here = every(context.items, (item) => item.activeFolderIds.includes(folder.id));
    const name = context.folderName(folder);
    return {
      id: `folder:${folder.id}`,
      label: name,
      ...(here ? { description: t.alreadyHere } : {}),
      visual: { kind: "icon", icon: folder.role === "inbox" ? "ti ti-inbox" : "ti ti-folder" },
      disabled: here,
      action: { kind: "move", folderId: folder.id, name },
    };
  });
};

export const mailDropTags = (context: MailDropContext): MailDropTarget[] => {
  const t = mailDropMessages.resolve([context.locale]).t;
  return context.tags.map((tag) => {
    const all = every(context.items, (item) => item.localTags.some((existing) => existing.id === tag.id));
    return {
      id: `tag:${tag.id}`,
      label: tag.name,
      ...(all ? { description: t.alreadyTagged } : {}),
      visual: { kind: "tag", color: tag.color },
      disabled: all,
      action: { kind: "tag", tagId: tag.id, name: tag.name },
    };
  });
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
