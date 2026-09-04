import { ResourceShortIdSchema } from "../contracts";
import { activityPublic, publicResources } from "../service";
import type { MailAutomationAccessData } from "../service/automation-workspace";
import type { MailFocusItem as InternalMailFocusItem, MailFocusMailboxCounts } from "../service/focus";
import type { MailboxPageData, MailConversationDetailData } from "../service/workspace";

type Table = publicResources.MailPublicResourceTable;
export type SsrPublicPath = { table: Table; segments: Array<string | number> };
type Path = SsrPublicPath;
type LoadPublicIds = typeof publicResources.publicIds;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const valueAt = (value: unknown, segments: Path["segments"]): unknown => {
  let current = value;
  for (const segment of segments) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
};

const setAt = (value: unknown, segments: Path["segments"], replacement: string): void => {
  let current = value;
  for (const segment of segments.slice(0, -1)) {
    if (!current || typeof current !== "object") return;
    current = (current as Record<string | number, unknown>)[segment];
  }
  if (current && typeof current === "object") {
    (current as Record<string | number, unknown>)[segments.at(-1)!] = replacement;
  }
};

export const projectSsrPaths = async <T>(value: T, paths: Path[], loadPublicIds: LoadPublicIds = publicResources.publicIds): Promise<T> => {
  const projected = structuredClone(value);
  const tables = [...new Set(paths.map((path) => path.table))];
  const maps = new Map(
    await Promise.all(
      tables.map(async (table) => {
        const ids = paths.flatMap((path) => {
          const id = path.table === table ? valueAt(projected, path.segments) : null;
          return typeof id === "string" && UUID.test(id) ? [id] : [];
        });
        return [table, await loadPublicIds(table, ids)] as const;
      }),
    ),
  );
  for (const path of paths) {
    const id = valueAt(projected, path.segments);
    if (typeof id === "string" && UUID.test(id))
      setAt(projected, path.segments, publicResources.requirePublicId(maps.get(path.table)!, id));
  }
  return projected;
};

export const projectSsrMailboxList = async <T extends { id: string }>(mailboxes: T[], loadPublicIds?: LoadPublicIds): Promise<T[]> => {
  const paths: Path[] = [];
  addResourceList(paths, "mailboxes", [], mailboxes);
  return projectSsrPaths(mailboxes, paths, loadPublicIds);
};

export const projectSsrFocusItems = async (items: InternalMailFocusItem[], loadPublicIds?: LoadPublicIds) => {
  const paths: Path[] = [];
  items.forEach((item, index) => {
    add(paths, "conversations", [index, "id"], item.id);
    add(paths, "mailboxes", [index, "mailboxId"], item.mailboxId);
  });
  return projectSsrPaths(items, paths, loadPublicIds);
};

export const projectSsrFocusPage = async <T extends { items: InternalMailFocusItem[]; mailboxCounts: MailFocusMailboxCounts[] }>(
  page: T,
  loadPublicIds?: LoadPublicIds,
): Promise<T> => {
  const paths: Path[] = [];
  page.items.forEach((item, index) => {
    add(paths, "conversations", ["items", index, "id"], item.id);
    add(paths, "mailboxes", ["items", index, "mailboxId"], item.mailboxId);
  });
  page.mailboxCounts.forEach((counts, index) => add(paths, "mailboxes", ["mailboxCounts", index, "mailboxId"], counts.mailboxId));
  return projectSsrPaths(page, paths, loadPublicIds);
};

export const projectMailConversationDetail = async (
  data: MailConversationDetailData,
  loadPublicIds?: LoadPublicIds,
): Promise<MailConversationDetailData> => {
  const activity = await activityPublic.projectActivityItems(data.activity, loadPublicIds);
  const paths: Path[] = [{ table: "conversations", segments: ["conversationId"] }];
  addResourceList(paths, "messages", ["detailMessages"], data.detailMessages);
  data.detailMessages.forEach((message, index) => {
    add(paths, "folders", ["detailMessages", index, "folderId"], message.folderId);
    add(paths, "deliveries", ["detailMessages", index, "delivery", "submissionId"], message.delivery?.submissionId);
    addResourceList(paths, "attachments", ["detailMessages", index, "attachments"], message.attachments);
  });
  addResourceList(paths, "drafts", ["conversationDrafts"], data.conversationDrafts);
  addResourceList(paths, "tags", ["localTags"], data.localTags);
  if (data.conversationLocalTags) {
    add(paths, "conversations", ["conversationLocalTags", "conversationId"], data.conversationLocalTags.conversationId);
    addResourceList(paths, "tags", ["conversationLocalTags", "tags"], data.conversationLocalTags.tags);
  }
  addResourceList(paths, "comments", ["comments"], data.comments);
  data.comments.forEach((comment, index) => {
    add(paths, "conversations", ["comments", index, "conversationId"], comment.conversationId);
    add(paths, "messages", ["comments", index, "referencedMessageId"], comment.referencedMessageId);
  });
  if (data.reminder) {
    add(paths, "reminders", ["reminder", "id"], data.reminder.id);
    add(paths, "conversations", ["reminder", "conversationId"], data.reminder.conversationId);
  }
  if (data.collaborationState)
    add(paths, "conversations", ["collaborationState", "conversationId"], data.collaborationState.conversationId);
  return projectSsrPaths({ ...data, activity }, paths, loadPublicIds);
};

export const resolveSsrMailboxId = async (
  shortId: string,
  resolve: typeof publicResources.resolveActiveMailboxId = publicResources.resolveActiveMailboxId,
): Promise<string | null> => {
  if (!ResourceShortIdSchema.safeParse(shortId).success) return null;
  return resolve(shortId);
};

export const resolveSsrMailboxResourceId = async (
  table: publicResources.MailboxOwnedPublicResourceTable,
  mailboxId: string,
  shortId: string,
  resolve: typeof publicResources.resolveMailboxPublicId = publicResources.resolveMailboxPublicId,
): Promise<string | null> => {
  if (!ResourceShortIdSchema.safeParse(shortId).success) return null;
  return resolve(table, mailboxId, shortId);
};

export const resolveSsrWorkspaceUrl = async (
  publicUrl: URL,
  mailboxId: string,
  resolve: typeof publicResources.resolveMailboxPublicIds = publicResources.resolveMailboxPublicIds,
): Promise<URL | null> => {
  const internalUrl = new URL(publicUrl);
  const resources = [
    ["savedView", "savedViews"],
    ["folder", "folders"],
    ["conversation", "conversations"],
    ["message", "messages"],
  ] as const;
  for (const [name, table] of resources) {
    const shortId = internalUrl.searchParams.get(name);
    if (shortId === null) continue;
    if (!ResourceShortIdSchema.safeParse(shortId).success) return null;
    const ids = await resolve(table, mailboxId, [shortId]);
    if (!ids) return null;
    internalUrl.searchParams.set(name, ids[0]!);
  }
  const encodedSearch = internalUrl.searchParams.get("search");
  if (!encodedSearch) return internalUrl;
  try {
    const state = JSON.parse(encodedSearch) as { expression?: unknown };
    const resources: Array<{ owner: Record<string, unknown>; field: "folderId" | "tagId"; table: "folders" | "tags"; shortId: string }> =
      [];
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const node = value as Record<string, unknown>;
      if (node.type === "folder_id" && typeof node.folderId === "string") {
        resources.push({ owner: node, field: "folderId", table: "folders", shortId: node.folderId });
      }
      if (node.type === "local_tag_id" && typeof node.tagId === "string") {
        resources.push({ owner: node, field: "tagId", table: "tags", shortId: node.tagId });
      }
      for (const child of Object.values(node)) Array.isArray(child) ? child.forEach(visit) : visit(child);
    };
    visit(state.expression);
    if (resources.some(({ shortId }) => !ResourceShortIdSchema.safeParse(shortId).success)) return null;
    for (const table of ["folders", "tags"] as const) {
      const selected = resources.filter((resource) => resource.table === table);
      if (selected.length === 0) continue;
      const ids = await resolve(
        table,
        mailboxId,
        selected.map(({ shortId }) => shortId),
      );
      if (!ids) return null;
      selected.forEach(({ owner, field }, index) => Object.assign(owner, { [field]: ids[index] }));
    }
    internalUrl.searchParams.set("search", JSON.stringify(state));
  } catch {
    // Keep malformed search state intact so the workspace can render its normal validation error.
  }
  return internalUrl;
};

const add = (paths: Path[], table: Table, segments: Path["segments"], value: unknown): void => {
  if (typeof value === "string" && UUID.test(value)) paths.push({ table, segments });
};

const addResourceList = (paths: Path[], table: Table, prefix: Path["segments"], values: unknown[]): void => {
  values.forEach((value, index) =>
    add(paths, table, [...prefix, index, "id"], value && typeof value === "object" ? (value as { id?: unknown }).id : null),
  );
};

export const projectMailboxPageData = async (data: MailboxPageData, loadPublicIds?: LoadPublicIds): Promise<MailboxPageData> => {
  const activity = await activityPublic.projectActivityItems(data.activity, loadPublicIds);
  const paths: Path[] = [{ table: "mailboxes", segments: ["mailbox", "id"] }];
  addResourceList(paths, "folders", ["folders"], data.folders);
  data.folders.forEach((item, index) => add(paths, "folders", ["folders", index, "parentId"], item.parentId));
  addResourceList(paths, "senderIdentities", ["identities"], data.identities);
  data.identities.forEach((item, index) => {
    add(paths, "composeTemplates", ["identities", index, "defaultSignatureTemplateId"], item.defaultSignatureTemplateId);
    add(paths, "folders", ["identities", index, "sentFolderId"], item.sentFolderId);
    add(paths, "folders", ["identities", index, "draftsFolderId"], item.draftsFolderId);
  });
  add(paths, "savedViews", ["savedViewId"], data.savedViewId);
  addResourceList(paths, "savedViews", ["savedViews"], data.savedViews);
  const visitSearchExpression = (value: unknown, prefix: Path["segments"]): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const expression = value as Record<string, unknown>;
    if (expression.type === "folder_id") add(paths, "folders", [...prefix, "folderId"], expression.folderId);
    if (expression.type === "local_tag_id") add(paths, "tags", [...prefix, "tagId"], expression.tagId);
    for (const [field, child] of Object.entries(expression)) {
      if (Array.isArray(child)) child.forEach((item, index) => visitSearchExpression(item, [...prefix, field, index]));
      else visitSearchExpression(child, [...prefix, field]);
    }
  };
  data.savedViews.forEach((view, index) => visitSearchExpression(view.filter.expression, ["savedViews", index, "filter", "expression"]));
  add(paths, "folders", ["folderId"], data.folderId);
  add(paths, "conversations", ["selectedConversationId"], data.selectedConversationId);
  add(paths, "messages", ["selectedMessageId"], data.selectedMessageId);
  data.listItems.forEach((item, index) => {
    add(paths, item.selectionKind === "conversation" ? "conversations" : "messages", ["listItems", index, "id"], item.id);
    add(paths, "conversations", ["listItems", index, "conversationId"], item.conversationId);
    add(paths, "folders", ["listItems", index, "sourceFolderId"], item.sourceFolderId);
    item.activeFolderIds.forEach((id, child) => add(paths, "folders", ["listItems", index, "activeFolderIds", child], id));
    item.unreadFolderIds.forEach((id, child) => add(paths, "folders", ["listItems", index, "unreadFolderIds", child], id));
    addResourceList(paths, "tags", ["listItems", index, "localTags"], item.localTags);
  });
  addResourceList(paths, "messages", ["detailMessages"], data.detailMessages);
  data.detailMessages.forEach((item, index) => {
    add(paths, "folders", ["detailMessages", index, "folderId"], item.folderId);
    add(paths, "deliveries", ["detailMessages", index, "delivery", "submissionId"], item.delivery?.submissionId);
    addResourceList(paths, "attachments", ["detailMessages", index, "attachments"], item.attachments);
  });
  addResourceList(paths, "drafts", ["conversationDrafts"], data.conversationDrafts);
  addResourceList(paths, "tags", ["localTags"], data.localTags);
  if (data.conversationLocalTags) {
    add(paths, "conversations", ["conversationLocalTags", "conversationId"], data.conversationLocalTags.conversationId);
    addResourceList(paths, "tags", ["conversationLocalTags", "tags"], data.conversationLocalTags.tags);
  }
  addResourceList(paths, "comments", ["comments"], data.comments);
  data.comments.forEach((item, index) => {
    add(paths, "conversations", ["comments", index, "conversationId"], item.conversationId);
    add(paths, "messages", ["comments", index, "referencedMessageId"], item.referencedMessageId);
  });
  if (data.reminder) {
    add(paths, "reminders", ["reminder", "id"], data.reminder.id);
    add(paths, "conversations", ["reminder", "conversationId"], data.reminder.conversationId);
  }
  if (data.collaborationState)
    add(paths, "conversations", ["collaborationState", "conversationId"], data.collaborationState.conversationId);
  if (data.scheduledPage) {
    addResourceList(paths, "deliveries", ["scheduledPage", "items"], data.scheduledPage.items);
    data.scheduledPage.items.forEach((item, index) => {
      add(paths, "drafts", ["scheduledPage", "items", index, "draftId"], item.draftId);
      add(paths, "conversations", ["scheduledPage", "items", index, "conversationId"], item.conversationId);
    });
  }
  return projectSsrPaths({ ...data, activity }, paths, loadPublicIds);
};

export const projectAutomationWorkspace = async <T extends MailAutomationAccessData>(
  data: T,
  loadPublicIds?: LoadPublicIds,
): Promise<T> => {
  const paths: Path[] = [{ table: "mailboxes", segments: ["mailbox", "id"] }];
  const record = data as Record<string, unknown>;
  for (const [field, table] of [
    ["identities", "senderIdentities"],
    ["automaticReplies", "automaticReplyConfigurations"],
    ["incomingAutomations", "incomingAutomations"],
  ] as const) {
    const items = record[field];
    if (Array.isArray(items)) addResourceList(paths, table, [field], items);
  }
  const identities = record.identities;
  if (Array.isArray(identities))
    identities.forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const identity = item as Record<string, unknown>;
      add(paths, "composeTemplates", ["identities", index, "defaultSignatureTemplateId"], identity.defaultSignatureTemplateId);
      add(paths, "folders", ["identities", index, "sentFolderId"], identity.sentFolderId);
      add(paths, "folders", ["identities", index, "draftsFolderId"], identity.draftsFolderId);
    });
  for (const field of ["automaticReplies", "incomingAutomations"] as const) {
    const items = record[field];
    if (Array.isArray(items))
      items.forEach((item, index) => {
        if (!item || typeof item !== "object") return;
        const resource = item as Record<string, unknown>;
        add(paths, "mailboxes", [field, index, "mailboxId"], resource.mailboxId);
        add(paths, "senderIdentities", [field, index, "senderIdentityId"], resource.senderIdentityId);
      });
  }
  const automations = record.incomingAutomations;
  if (Array.isArray(automations)) {
    const visitSteps = (steps: unknown, prefix: Path["segments"]): void => {
      if (!Array.isArray(steps)) return;
      steps.forEach((step, index) => {
        if (!step || typeof step !== "object") return;
        const value = step as Record<string, unknown>;
        const path = [...prefix, index];
        if (value.kind === "mail_action" && value.action && typeof value.action === "object") {
          const action = value.action as Record<string, unknown>;
          add(paths, "folders", [...path, "action", "folderId"], action.folderId);
          add(paths, "tags", [...path, "action", "tagId"], action.tagId);
        }
        if (value.kind === "create_reply_draft") add(paths, "senderIdentities", [...path, "senderIdentityId"], value.senderIdentityId);
        if (value.kind === "if") {
          visitSteps(value.then, [...path, "then"]);
          visitSteps(value.else, [...path, "else"]);
        }
      });
    };
    automations.forEach((automation, index) => {
      if (automation && typeof automation === "object")
        visitSteps((automation as Record<string, unknown>).steps, ["incomingAutomations", index, "steps"]);
    });
  }
  const catalog = record.catalog;
  if (catalog && typeof catalog === "object") {
    const value = catalog as Record<string, unknown>;
    for (const [field, table] of [
      ["folders", "folders"],
      ["senderIdentities", "senderIdentities"],
      ["localTags", "tags"],
    ] as const) {
      const items = value[field];
      if (Array.isArray(items)) addResourceList(paths, table, ["catalog", field], items);
    }
  }
  const projected = await projectSsrPaths(data, paths, loadPublicIds);
  const publicMailboxId = projected.mailbox.id;
  const internalMailboxId = data.mailbox.id;
  const projectActivityHrefs = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    value.forEach((item) => {
      if (!item || typeof item !== "object") return;
      const activity = item as Record<string, unknown>;
      if (typeof activity.href === "string" && activity.href.startsWith(`/app/mail/${internalMailboxId}/automations`)) {
        activity.href = activity.href.replace(`/app/mail/${internalMailboxId}/`, `/app/mail/${publicMailboxId}/`);
      }
    });
  };
  const projectedRecord = projected as Record<string, unknown>;
  projectActivityHrefs(projectedRecord.recentActivity);
  projectActivityHrefs(projectedRecord.items);
  return projected;
};

export const projectComposeData = async <T extends { mailbox: { id: string }; identities: Array<{ id: string }>; draft?: unknown }>(
  data: T,
  loadPublicIds?: LoadPublicIds,
): Promise<T> => {
  const paths: Path[] = [{ table: "mailboxes", segments: ["mailbox", "id"] }];
  addResourceList(paths, "senderIdentities", ["identities"], data.identities);
  data.identities.forEach((identity, index) => {
    const value = identity as Record<string, unknown>;
    add(paths, "composeTemplates", ["identities", index, "defaultSignatureTemplateId"], value.defaultSignatureTemplateId);
    add(paths, "folders", ["identities", index, "sentFolderId"], value.sentFolderId);
    add(paths, "folders", ["identities", index, "draftsFolderId"], value.draftsFolderId);
  });
  if (data.draft && typeof data.draft === "object") {
    const draft = data.draft as Record<string, unknown>;
    add(paths, "drafts", ["draft", "id"], draft.id);
    add(paths, "conversations", ["draft", "conversationId"], draft.conversationId);
    add(paths, "messages", ["draft", "derivedFromMessageId"], draft.derivedFromMessageId);
    add(paths, "senderIdentities", ["draft", "senderIdentityId"], draft.senderIdentityId);
    if (Array.isArray(draft.attachments)) addResourceList(paths, "draftAttachments", ["draft", "attachments"], draft.attachments);
  }
  return projectSsrPaths(data, paths, loadPublicIds);
};
