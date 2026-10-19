import type { MailSearchExpression } from "./contracts";

/**
 * The folders every match of `expression` lies in, or null when a match can lie in any folder. Search scopes a hit's
 * unread folders to them, so the browser compares a row's unread state with the same rule.
 */
export const guaranteedMailSearchFolderIds = (expression: MailSearchExpression): string[] | null => {
  if (expression.type === "folder_id") return [expression.folderId];
  if (expression.type === "not") return null;
  if (expression.type === "and") {
    const ids = expression.expressions.flatMap((child) => guaranteedMailSearchFolderIds(child) ?? []);
    return ids.length > 0 ? [...new Set(ids)] : null;
  }
  if (expression.type === "or") {
    const scopes = expression.expressions.map(guaranteedMailSearchFolderIds);
    if (scopes.some((scope) => scope === null)) return null;
    return [...new Set(scopes.flatMap((scope) => scope ?? []))];
  }
  return null;
};
