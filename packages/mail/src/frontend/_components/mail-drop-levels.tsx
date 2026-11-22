import { AvatarFaces, type DragPayload, DropOverlay, type DropOverlayLevel, type DropOverlayTile, dropOverlayPages, toast } from "@k2b/ui";
import { avatarUrl } from "./mail-assign-picker";
import { MAIL_CONVERSATION_DRAG } from "./mail-drag";
import { mailDropMessages } from "./mail-drop-messages";
import {
  MAIL_DROP_FIRST_LEVEL_SIZE,
  type MailDropAction,
  type MailDropContext,
  type MailDropTarget,
  mailDropFolderTargets,
  mailDropPeople,
  mailDropRoot,
  mailDropTags,
  readMailDropRecentFolders,
} from "./mail-drop-targets";

// The drop's other code loads with this module, in one request after the page (S7).
export { createMailDropHost, runMailDrop } from "./mail-drop-actions";
export { mailDropMessages } from "./mail-drop-messages";
export { readMailDropRecentFolders, rememberMailDropFolder } from "./mail-drop-targets";

/**
 * A level of the drop surface (S7), from the first load's data: no request before the drop. People and folders show
 * 11 and "More N", then ranges of 12; where the search knows more people, it stays one drop away. A drop runs through
 * `runDrop`, the same paths as the menus.
 */
export const mailDropLevel = <Item extends MailDropContext["items"][number]>(params: {
  id: string;
  mailboxId: string;
  /** Recently used folders come from this browser's memory of the mailbox. */
  context: Omit<MailDropContext, "items" | "recentFolderIds"> & { items: readonly Item[] };
  runDrop: (action: MailDropAction, items: readonly Item[]) => unknown;
}): DropOverlayLevel => {
  const { id, runDrop } = params;
  const items = params.context.items;
  const context: MailDropContext = { ...params.context, recentFolderIds: readMailDropRecentFolders(params.mailboxId) };
  const text = mailDropMessages.resolve([context.locale]).t;
  const tile = (target: MailDropTarget): DropOverlayTile => ({
    id: target.id,
    label: target.label,
    ...(target.disabled ? { disabled: target.description } : target.description ? { description: target.description } : {}),
    ...(target.visual.kind === "icon" ? { icon: target.visual.icon } : {}),
    ...(target.visual.kind === "person"
      ? {
          leading: <AvatarFaces people={[{ name: target.visual.person.displayName, src: avatarUrl(target.visual.person) }]} max={1} />,
        }
      : {}),
    ...(target.visual.kind === "tag"
      ? { leading: <span class="mail-drop-tag" style={{ "--mail-tag": target.visual.color }} aria-hidden="true" /> }
      : {}),
    ...(target.level ? { opens: target.level } : {}),
    ...(target.action ? { onDrop: () => void runDrop(target.action!, items) } : {}),
  });
  const range = (first: string, last: string) => (first === last ? first : `${first} – ${last}`);
  const people = mailDropPeople(context);
  const peoplePages = dropOverlayPages(
    "assign",
    people.targets.map(tile),
    { title: text.assignFrequentCrumb, moreTitle: text.assignMoreCrumb, more: (count) => text.morePeople({ count }), range },
    { first: MAIL_DROP_FIRST_LEVEL_SIZE },
  );
  const folderPages = dropOverlayPages(
    "folder",
    mailDropFolderTargets(context).map(tile),
    {
      title: context.recentFolderIds.length > 0 ? text.folderRecentCrumb : text.folderCrumb,
      moreTitle: text.folderMoreCrumb,
      more: (count) => text.moreFolders({ count }),
      range,
    },
    { first: MAIL_DROP_FIRST_LEVEL_SIZE },
  );
  const assign = peoplePages(id);
  if (assign)
    return id === "assign" && people.more
      ? {
          ...assign,
          tiles: [
            ...assign.tiles,
            {
              id: "search",
              label: text.searchPeople,
              icon: "ti ti-search",
              onDrop: () => void runDrop({ kind: "choose-assignee" }, items),
            },
          ],
        }
      : assign;
  const folder = folderPages(id);
  if (folder) return folder;
  if (id === "tag") return { title: text.tagCrumb, tiles: mailDropTags(context).map(tile) };
  return { tiles: mailDropRoot(context).map(tile) };
};

/**
 * The drop surface over list and reader (S7): while a conversation is dragged, its targets cover them and the sidebar
 * stays free. It mounts with the drop's code, before any row can drag.
 */
export const MailDropSurface = (props: { level: (id: string, payload: DragPayload) => DropOverlayLevel; locale: string }) => {
  const text = () => mailDropMessages.resolve([props.locale]).t;
  return (
    <DropOverlay
      class="mail-drop-overlay"
      accept={[MAIL_CONVERSATION_DRAG]}
      level={props.level}
      hint={text().sidebarHint}
      onCancel={() => toast(text().cancelled)}
    />
  );
};
