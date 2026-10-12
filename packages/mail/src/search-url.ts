import type { MailSearchExpression, MailSearchState } from "./contracts";
import { isResourceShortId } from "./resource-short-id";

export const MAIL_SEARCH_PARAMETER = "search";
export const MAIL_QUICK_SEARCH_FIELDS_PARAMETER = "qFields";
export const MAIL_QUICK_SEARCH_FIELDS = ["any", "from", "recipients", "subject", "body", "attachment_name"] as const;
export type MailQuickSearchField = (typeof MAIL_QUICK_SEARCH_FIELDS)[number];
export const DEFAULT_MAIL_QUICK_SEARCH_FIELDS = ["any"] as const satisfies readonly MailQuickSearchField[];

// The workspace-route API accepts hrefs up to 4,000 characters. Keeping the
// encoded search value below 3,000 leaves room for the mailbox path and future
// non-search route state without relying on browser-specific URL limits.
export const MAX_MAIL_SEARCH_PARAMETER_LENGTH = 3_000;

export type { MailSearchState } from "./contracts";

/** Why a search cannot be kept in or read from the mailbox URL; the interface owns the human message. */
export type MailSearchStateError = "invalid" | "too_large";

export type ParsedMailSearchState =
  | { state: MailSearchState; error: null }
  | { state: null; error: MailSearchStateError }
  | { state: null; error: null };

export type SerializedMailSearchState = { ok: true; value: string } | { ok: false; error: MailSearchStateError };
export type ResolvedMailSearchRoute = {
  query: string;
  expression: MailSearchExpression | null;
  sort: MailSearchState["sort"];
  error: MailSearchStateError | null;
};

export const encodedParameterLength = (value: string): number => {
  const encoded = new URLSearchParams({ [MAIL_SEARCH_PARAMETER]: value }).toString();
  return encoded.length - `${MAIL_SEARCH_PARAMETER}=`.length;
};

export const parseMailQuickSearchFields = (url: URL): MailQuickSearchField[] => {
  const raw = url.searchParams.get(MAIL_QUICK_SEARCH_FIELDS_PARAMETER);
  if (!raw) return [];
  const allowed = new Set<string>(MAIL_QUICK_SEARCH_FIELDS);
  return [...new Set(raw.split(",").filter((field): field is MailQuickSearchField => allowed.has(field)))];
};

export const simpleMailSearchExpression = (
  query: string,
  fields: readonly MailQuickSearchField[] = DEFAULT_MAIL_QUICK_SEARCH_FIELDS,
): MailSearchExpression | null => {
  const normalized = query.trim();
  if (!normalized) return null;
  const selectedFields = fields.length > 0 ? fields : DEFAULT_MAIL_QUICK_SEARCH_FIELDS;
  const expressions = selectedFields.map((field) => ({
    type: "text" as const,
    field,
    query: normalized,
    match: "words" as const,
  }));
  return expressions.length === 1 ? expressions[0]! : { type: "or", expressions };
};

export type MailSearchReference = Extract<MailSearchExpression, { type: "folder_id" | "local_tag_id" }>;

/** Stands in for a folder or tag condition whose folder or tag no longer exists: it matches nothing. */
export const MAIL_SEARCH_MATCHES_NOTHING: MailSearchExpression = { type: "not", expression: { type: "all" } };

/** Lists the folder and tag conditions of an expression. */
export const mailSearchReferences = (expression: MailSearchExpression): MailSearchReference[] => {
  if (expression.type === "and" || expression.type === "or") return expression.expressions.flatMap(mailSearchReferences);
  if (expression.type === "not") return mailSearchReferences(expression.expression);
  return expression.type === "folder_id" || expression.type === "local_tag_id" ? [expression] : [];
};

/** Replaces every folder and tag condition of an expression and keeps all other conditions. */
export const replaceMailSearchReferences = (
  expression: MailSearchExpression,
  replace: (reference: MailSearchReference) => MailSearchExpression,
): MailSearchExpression => {
  if (expression.type === "and" || expression.type === "or") {
    return { ...expression, expressions: expression.expressions.map((child) => replaceMailSearchReferences(child, replace)) };
  }
  if (expression.type === "not") return { ...expression, expression: replaceMailSearchReferences(expression.expression, replace) };
  return expression.type === "folder_id" || expression.type === "local_tag_id" ? replace(expression) : expression;
};

const serializeBuiltMailSearch = (state: MailSearchState): SerializedMailSearchState => {
  const value = JSON.stringify(state);
  return encodedParameterLength(value) > MAX_MAIL_SEARCH_PARAMETER_LENGTH ? { ok: false, error: "too_large" } : { ok: true, value };
};

export const mailTagSearch = (tagId: string): SerializedMailSearchState =>
  isResourceShortId(tagId)
    ? serializeBuiltMailSearch({ expression: { type: "local_tag_id", tagId }, sort: "newest" })
    : { ok: false, error: "invalid" };

export const mailExactAddressSearch = (field: "from" | "participants", address: string): SerializedMailSearchState => {
  const query = address.trim();
  if (query.length < 1 || [...query].length > 500) return { ok: false, error: "invalid" };
  return serializeBuiltMailSearch({ expression: { type: "text", field, query, match: "exact" }, sort: "newest" });
};
