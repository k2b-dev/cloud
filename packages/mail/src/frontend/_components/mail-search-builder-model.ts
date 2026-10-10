import type { MailSearchExpression, MailSearchField } from "../../contracts";
import { type MailFolderTreeEntry, mailFolderPaths } from "../../folder-tree";
import { mailRemainingMessages } from "./mail-remaining-messages";

export type MailSearchNodePath = readonly number[];

export type MailSearchFieldKey =
  | `text:${MailSearchField}`
  | "date:internal_date"
  | "date:sent_at"
  | "size:message"
  | "size:attachment"
  | "work_status"
  | "assignee"
  | "snoozed"
  | "all"
  | "folder_id"
  | "local_tag_id"
  | "assigned_to_me"
  | "kept";

export const MAIL_SEARCH_FIELD_GROUPS = [
  { value: "recommended" },
  { value: "content" },
  { value: "people" },
  { value: "mailbox" },
  { value: "date-size" },
  { value: "technical" },
] as const;

type MailSearchFieldOption = { id: MailSearchFieldKey; icon: string; groups: readonly string[] };

export const MAIL_SEARCH_FIELD_OPTIONS: MailSearchFieldOption[] = [
  { id: "text:any", icon: "ti ti-search", groups: ["recommended", "content"] },
  { id: "text:subject", icon: "ti ti-letter-case", groups: ["recommended", "content"] },
  { id: "text:body", icon: "ti ti-align-left", groups: ["content"] },
  { id: "text:from", icon: "ti ti-user-up", groups: ["recommended", "people"] },
  { id: "text:to", icon: "ti ti-user-down", groups: ["recommended", "people"] },
  { id: "text:cc", icon: "ti ti-users", groups: ["people"] },
  { id: "text:bcc", icon: "ti ti-users-minus", groups: ["people"] },
  { id: "text:recipients", icon: "ti ti-address-book", groups: ["people"] },
  { id: "text:participants", icon: "ti ti-users-group", groups: ["people"] },
  { id: "text:message_id", icon: "ti ti-id", groups: ["technical"] },
  { id: "text:attachment_name", icon: "ti ti-paperclip", groups: ["content"] },
  { id: "text:comment", icon: "ti ti-message", groups: ["content"] },
  { id: "text:reference", icon: "ti ti-hash", groups: ["content", "technical"] },
  { id: "text:folder", icon: "ti ti-folder", groups: ["mailbox"] },
  { id: "text:tag", icon: "ti ti-tag", groups: ["mailbox"] },
  { id: "date:internal_date", icon: "ti ti-calendar-down", groups: ["recommended", "date-size"] },
  { id: "date:sent_at", icon: "ti ti-calendar-up", groups: ["date-size"] },
  { id: "size:message", icon: "ti ti-file", groups: ["date-size"] },
  { id: "size:attachment", icon: "ti ti-file-download", groups: ["date-size"] },
  { id: "work_status", icon: "ti ti-progress-check", groups: ["recommended", "mailbox"] },
  { id: "assignee", icon: "ti ti-user-check", groups: ["recommended", "people", "mailbox"] },
  { id: "snoozed", icon: "ti ti-alarm-snooze", groups: ["mailbox"] },
  { id: "folder_id", icon: "ti ti-folder-check", groups: ["recommended", "mailbox"] },
  { id: "local_tag_id", icon: "ti ti-tag", groups: ["recommended", "mailbox"] },
  { id: "assigned_to_me", icon: "ti ti-user-pin", groups: ["people", "mailbox"] },
  { id: "kept", icon: "ti ti-lock", groups: ["mailbox"] },
  { id: "all", icon: "ti ti-mail", groups: ["mailbox"] },
];

const LEGACY_PROVIDER_KEYWORD_OPTION = {
  id: "text:keyword",
  icon: "ti ti-key",
  groups: ["technical"],
} as const;

export const mailSearchFieldOptionsFor = (expression: MailSearchExpression): MailSearchFieldOption[] =>
  mailSearchFieldKey(expression) === "text:keyword"
    ? [...MAIL_SEARCH_FIELD_OPTIONS, LEGACY_PROVIDER_KEYWORD_OPTION]
    : MAIL_SEARCH_FIELD_OPTIONS;

export const unwrapMailSearchNot = (
  expression: MailSearchExpression,
): { expression: Exclude<MailSearchExpression, { type: "not" }>; negated: boolean } => {
  if (expression.type === "not") {
    const nested = unwrapMailSearchNot(expression.expression);
    return { expression: nested.expression, negated: !nested.negated };
  }
  return { expression, negated: false };
};

export const applyMailSearchNegation = (
  expression: Exclude<MailSearchExpression, { type: "not" }>,
  negated: boolean,
): MailSearchExpression => (negated ? { type: "not", expression } : expression);

export const ensureMailSearchRootGroup = (expression: MailSearchExpression): MailSearchExpression => {
  const unwrapped = unwrapMailSearchNot(expression);
  if (!unwrapped.negated && (unwrapped.expression.type === "and" || unwrapped.expression.type === "or")) return expression;
  return { type: "and", expressions: [expression] };
};

const compactMailSearchExpression = (expression: MailSearchExpression): MailSearchExpression | null => {
  if (expression.type === "text") return expression.query.trim() ? { ...expression, query: expression.query.trim() } : null;
  if (expression.type === "not") {
    const nested = compactMailSearchExpression(expression.expression);
    return nested ? { type: "not", expression: nested } : null;
  }
  if (expression.type === "and" || expression.type === "or") {
    const expressions = expression.expressions
      .map(compactMailSearchExpression)
      .filter((child): child is MailSearchExpression => child !== null);
    return expressions.length > 0 ? { ...expression, expressions } : null;
  }
  return expression;
};

/** Removes incomplete text rows before a search is applied or saved. */
export const normalizeMailSearchExpression = (expression: MailSearchExpression): MailSearchExpression =>
  compactMailSearchExpression(expression) ?? { type: "all" };

export const mailSearchFieldKey = (expression: MailSearchExpression): MailSearchFieldKey | null => {
  const node = unwrapMailSearchNot(expression).expression;
  if (node.type === "text") return `text:${node.field}`;
  if (node.type === "date") return `date:${node.field}`;
  if (node.type === "size") return `size:${node.field}`;
  if (node.type === "and" || node.type === "or") return null;
  return node.type;
};

export const createMailSearchCondition = (
  field: MailSearchFieldKey,
): Exclude<MailSearchExpression, { type: "not" } | { type: "and" } | { type: "or" }> => {
  if (field.startsWith("text:")) {
    return { type: "text", field: field.slice(5) as MailSearchField, query: "", match: "words" };
  }
  if (field.startsWith("date:")) {
    return {
      type: "date",
      field: field.slice(5) as "internal_date" | "sent_at",
      operator: "on_or_after",
      value: new Date().toISOString(),
    };
  }
  if (field.startsWith("size:")) {
    return { type: "size", field: field.slice(5) as "message" | "attachment", operator: "at_least", bytes: 1024 * 1024 };
  }
  if (field === "work_status") return { type: "work_status", value: "needs_action" };
  if (field === "assignee") return { type: "assignee", userId: null };
  if (field === "folder_id") return { type: "folder_id", folderId: "" };
  if (field === "local_tag_id") return { type: "local_tag_id", tagId: "" };
  if (field === "assigned_to_me") return { type: "assigned_to_me" };
  if (field === "kept") return { type: "kept" };
  if (field === "all") return { type: "all" };
  return { type: "snoozed", value: true };
};

const rebuildWrapped = (original: MailSearchExpression, expression: Exclude<MailSearchExpression, { type: "not" }>): MailSearchExpression =>
  applyMailSearchNegation(expression, unwrapMailSearchNot(original).negated);

export const updateMailSearchExpression = (
  root: MailSearchExpression,
  path: MailSearchNodePath,
  update: (expression: MailSearchExpression) => MailSearchExpression,
): MailSearchExpression => {
  if (path.length === 0) return update(root);
  const [index, ...rest] = path;
  const unwrapped = unwrapMailSearchNot(root);
  if ((unwrapped.expression.type !== "and" && unwrapped.expression.type !== "or") || index === undefined) return root;
  const child = unwrapped.expression.expressions[index];
  if (!child) return root;
  const expressions = [...unwrapped.expression.expressions];
  expressions[index] = updateMailSearchExpression(child, rest, update);
  return rebuildWrapped(root, { ...unwrapped.expression, expressions });
};

export const removeMailSearchExpression = (root: MailSearchExpression, path: MailSearchNodePath): MailSearchExpression => {
  if (path.length === 0) return root;
  const parentPath = path.slice(0, -1);
  const index = path.at(-1);
  if (index === undefined) return root;
  return updateMailSearchExpression(root, parentPath, (parent) => {
    const unwrapped = unwrapMailSearchNot(parent);
    if (unwrapped.expression.type !== "and" && unwrapped.expression.type !== "or") return parent;
    const expressions = unwrapped.expression.expressions.filter((_, childIndex) => childIndex !== index);
    if (expressions.length === 0) return parent;
    return rebuildWrapped(parent, { ...unwrapped.expression, expressions });
  });
};

export const appendMailSearchExpression = (
  root: MailSearchExpression,
  path: MailSearchNodePath,
  child: MailSearchExpression,
): MailSearchExpression =>
  updateMailSearchExpression(root, path, (parent) => {
    const unwrapped = unwrapMailSearchNot(parent);
    if (unwrapped.expression.type !== "and" && unwrapped.expression.type !== "or") return parent;
    return rebuildWrapped(parent, { ...unwrapped.expression, expressions: [...unwrapped.expression.expressions, child] });
  });

export const toggleMailSearchNegation = (root: MailSearchExpression, path: MailSearchNodePath): MailSearchExpression =>
  updateMailSearchExpression(root, path, (expression) => (expression.type === "not" ? expression.expression : { type: "not", expression }));

export const countMailSearchNodes = (expression: MailSearchExpression): number => {
  if (expression.type === "not") return 1 + countMailSearchNodes(expression.expression);
  if (expression.type === "and" || expression.type === "or") {
    return 1 + expression.expressions.reduce((total, child) => total + countMailSearchNodes(child), 0);
  }
  return 1;
};

export const mailSearchExpressionDepth = (expression: MailSearchExpression): number => {
  if (expression.type === "not") return 1 + mailSearchExpressionDepth(expression.expression);
  if (expression.type === "and" || expression.type === "or") {
    return 1 + Math.max(...expression.expressions.map(mailSearchExpressionDepth));
  }
  return 1;
};

const sizeLabel = (bytes: number, locale: string): string => {
  const megabytes = bytes / (1024 * 1024);
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(megabytes)} MB`;
};

/**
 * Folders and tags the summary can name. A missing list keeps the summary neutral; a present list is
 * authoritative, so a reference outside it belongs to a deleted folder or tag. IDs are never shown.
 */
export type MailSearchSummaryReferences = {
  folders?: readonly MailFolderTreeEntry[];
  tags?: readonly { id: string; name: string }[];
};

export const summarizeMailSearchExpression = (
  expression: MailSearchExpression,
  locale = typeof document === "undefined" ? "en" : document.documentElement.lang,
  references: MailSearchSummaryReferences = {},
): string => {
  const messages = mailRemainingMessages.resolve([locale]).t;
  const folderPaths = references.folders ? mailFolderPaths(references.folders) : null;
  const tagNames = references.tags ? new Map(references.tags.map((tag) => [tag.id, tag.name])) : null;
  const summarize = (node: MailSearchExpression): string => {
    if (node.type === "not") return `${messages.not} (${summarize(node.expression)})`;
    if (node.type === "and" || node.type === "or") {
      const separator = node.type === "and" ? ` ${messages.and} ` : ` ${messages.or} `;
      return node.expressions.map((child) => `(${summarize(child)})`).join(separator);
    }
    if (node.type === "text") {
      const field = node.field === "keyword" ? "text:keyword" : `text:${node.field}`;
      return `${messages.searchField({ field })} ${messages.textOperator({ operator: node.match })} ${messages.quoted({ text: node.query || "…" })}`;
    }
    if (node.type === "date") {
      return `${node.field === "internal_date" ? messages.received : messages.sent} ${messages.textOperator({ operator: node.operator })} ${node.value}`;
    }
    if (node.type === "size") {
      return `${node.field === "message" ? messages.message : messages.attachment} ${messages.size.toLocaleLowerCase(locale)} ${messages.textOperator({ operator: node.operator })} ${sizeLabel(node.bytes, locale)}`;
    }
    if (node.type === "work_status") {
      return `${messages.workStatus}: ${messages.automationStatus({ status: node.value })}`;
    }
    if (node.type === "assignee") return node.userId ? messages.assignedTo({ id: node.userId }) : messages.unassigned;
    if (node.type === "snoozed") return node.value ? messages.isSnoozed : messages.isNotSnoozed;
    if (node.type === "folder_id") {
      if (!folderPaths) return messages.inSpecificFolder;
      const path = folderPaths.get(node.folderId);
      return path ? messages.inFolder({ name: path }) : messages.inDeletedFolder;
    }
    if (node.type === "local_tag_id") {
      if (!tagNames) return messages.hasSpecificTag;
      const name = tagNames.get(node.tagId);
      return name ? messages.hasTag({ name }) : messages.hasDeletedTag;
    }
    if (node.type === "assigned_to_me") return messages.assignedToMe;
    if (node.type === "kept") return messages.searchField({ field: "kept" });
    return messages.searchField({ field: "all" });
  };
  return summarize(expression);
};
