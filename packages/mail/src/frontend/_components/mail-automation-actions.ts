import type { MailAutomationAction } from "../../contracts";
import type { MailWorkflowCatalogSnapshot } from "../../workflows/catalog";

export type AutomationActionKind = MailAutomationAction["kind"];

const PROVIDER_ACTION_KINDS = new Set<AutomationActionKind>(["junk", "trash", "mark_read", "add_keyword", "move_to_folder"]);

export const mailAutomationActionKindLabels: Record<AutomationActionKind, string> = {
  junk: "Move to junk",
  trash: "Move to trash",
  mark_read: "Mark as read",
  add_keyword: "Add provider keyword",
  move_to_folder: "Move to folder",
  add_local_tag: "Add tag",
  assign_user: "Assign user",
  set_status: "Set conversation status",
};

export const mailAutomationStatusLabels = {
  needs_action: "Needs action",
  waiting: "Waiting",
  done: "Done",
} as const;

export const mailAutomationDestinationFolders = (catalog: MailWorkflowCatalogSnapshot) =>
  catalog.folders.filter((folder) => folder.role !== "junk" && folder.role !== "trash");

export const mailAutomationActionLabel = (action: MailAutomationAction, catalog: MailWorkflowCatalogSnapshot): string => {
  if (action.kind === "junk") return "Move to junk";
  if (action.kind === "trash") return "Move to trash";
  if (action.kind === "mark_read") return "Mark as read";
  if (action.kind === "add_keyword") return `Add keyword ${action.keyword}`;
  if (action.kind === "move_to_folder") {
    const folder = catalog.folders.find((candidate) => candidate.id === action.folderId);
    return `Move to ${folder?.path ?? folder?.name ?? "folder"}`;
  }
  if (action.kind === "add_local_tag") {
    return `Add tag ${catalog.localTags?.find((tag) => tag.id === action.tagId)?.name ?? "tag"}`;
  }
  if (action.kind === "assign_user") {
    return `Assign ${catalog.assignableUsers.find((user) => user.id === action.userId)?.name ?? "user"}`;
  }
  return `Set status to ${mailAutomationStatusLabels[action.status]}`;
};

export const initialMailAutomationAction = (kind: AutomationActionKind, catalog?: MailWorkflowCatalogSnapshot): MailAutomationAction => {
  if (kind === "junk" || kind === "trash" || kind === "mark_read") return { kind };
  if (kind === "add_keyword") return { kind, keyword: "" };
  if (kind === "move_to_folder") {
    const folder = catalog ? mailAutomationDestinationFolders(catalog)[0] : null;
    return folder ? { kind, folderId: folder.id } : { kind: "junk" };
  }
  if (kind === "add_local_tag") {
    const tag = catalog?.localTags?.[0];
    return tag ? { kind, tagId: tag.id } : { kind: "junk" };
  }
  if (kind === "assign_user") {
    const user = catalog?.assignableUsers[0];
    return user ? { kind, userId: user.id } : { kind: "junk" };
  }
  return { kind, status: "needs_action" };
};

export const mailAutomationActionKindsFor = (params: {
  actions: MailAutomationAction[];
  catalog: MailWorkflowCatalogSnapshot | null;
  index?: number;
}): AutomationActionKind[] => {
  const current = params.index === undefined ? null : params.actions[params.index];
  const others = params.actions.filter((_, candidateIndex) => candidateIndex !== params.index);
  const providerTaken = others.some((action) => PROVIDER_ACTION_KINDS.has(action.kind));
  const assigned = others.some((action) => action.kind === "assign_user");
  const statusSet = others.some((action) => action.kind === "set_status");
  const usedTagIds = new Set(others.flatMap((action) => (action.kind === "add_local_tag" ? [action.tagId] : [])));
  const catalog = params.catalog;
  if (!catalog) return current ? [current.kind] : [];
  const available: AutomationActionKind[] = ["junk", "trash", "move_to_folder", "mark_read", "add_local_tag", "assign_user", "set_status"];
  if (current?.kind === "add_keyword") available.push("add_keyword");
  return available.filter((kind) => {
    if (kind === current?.kind) return true;
    if (PROVIDER_ACTION_KINDS.has(kind) && providerTaken) return false;
    if (kind === "move_to_folder" && mailAutomationDestinationFolders(catalog).length === 0) return false;
    if (kind === "add_local_tag" && !(catalog.localTags ?? []).some((tag) => !usedTagIds.has(tag.id))) return false;
    if (kind === "assign_user" && (assigned || catalog.assignableUsers.length === 0)) return false;
    if (kind === "set_status" && statusSet) return false;
    return true;
  });
};

export const createMailAutomationAction = (params: {
  kind: AutomationActionKind;
  actions: MailAutomationAction[];
  catalog: MailWorkflowCatalogSnapshot | null;
  index?: number;
}): MailAutomationAction | null => {
  if (params.kind === "junk" || params.kind === "trash" || params.kind === "mark_read") return { kind: params.kind };
  if (params.kind === "add_keyword") return { kind: params.kind, keyword: "" };
  if (!params.catalog) return null;
  if (params.kind === "move_to_folder") {
    const folder = mailAutomationDestinationFolders(params.catalog)[0];
    return folder ? { kind: params.kind, folderId: folder.id } : null;
  }
  if (params.kind === "add_local_tag") {
    const usedTagIds = new Set(
      params.actions.flatMap((action, candidateIndex) =>
        candidateIndex !== params.index && action.kind === "add_local_tag" ? [action.tagId] : [],
      ),
    );
    const tag = (params.catalog.localTags ?? []).find((candidate) => !usedTagIds.has(candidate.id));
    return tag ? { kind: params.kind, tagId: tag.id } : null;
  }
  if (params.kind === "assign_user") {
    const user = params.catalog.assignableUsers[0];
    return user ? { kind: params.kind, userId: user.id } : null;
  }
  return { kind: params.kind, status: "needs_action" };
};
