import { type MailSearchState, mailSearchExpressionSchema, mailSearchStateSchema } from "./contracts";
import {
  encodedParameterLength,
  MAIL_SEARCH_PARAMETER,
  MAX_MAIL_SEARCH_PARAMETER_LENGTH,
  parseMailQuickSearchFields,
  type ParsedMailSearchState,
  type ResolvedMailSearchRoute,
  type SerializedMailSearchState,
  simpleMailSearchExpression,
} from "./search-url";

export * from "./search-url";
export { mailSearchStateSchema };

export const serializeMailSearchState = (state: MailSearchState): SerializedMailSearchState => {
  const parsed = mailSearchStateSchema.safeParse(state);
  if (!parsed.success) return { ok: false, error: "invalid" };

  const value = JSON.stringify(parsed.data);
  if (encodedParameterLength(value) > MAX_MAIL_SEARCH_PARAMETER_LENGTH) {
    return { ok: false, error: "too_large" };
  }
  return { ok: true, value };
};

export const parseMailSearchState = (url: URL): ParsedMailSearchState => {
  const value = url.searchParams.get(MAIL_SEARCH_PARAMETER);
  if (value === null) return { state: null, error: null };
  if (!value) return { state: null, error: "invalid" };
  if (encodedParameterLength(value) > MAX_MAIL_SEARCH_PARAMETER_LENGTH) return { state: null, error: "too_large" };

  try {
    const parsed = mailSearchStateSchema.safeParse(JSON.parse(value));
    return parsed.success ? { state: parsed.data, error: null } : { state: null, error: "invalid" };
  } catch {
    return { state: null, error: "invalid" };
  }
};

export const resolveMailSearchRoute = (url: URL): ResolvedMailSearchRoute => {
  const query = url.searchParams.get("q")?.trim() ?? "";
  const structured = parseMailSearchState(url);
  if (structured.error) return { query, expression: null, sort: "relevance", error: structured.error };
  if (structured.state) {
    return {
      query,
      expression: structured.state.expression,
      sort: structured.state.sort,
      error: null,
    };
  }

  const fields = parseMailQuickSearchFields(url);
  const expression = simpleMailSearchExpression(query, fields.length > 0 ? fields : undefined);
  if (!expression) return { query, expression: null, sort: "relevance", error: null };
  const parsed = mailSearchExpressionSchema.safeParse(expression);
  return parsed.success
    ? { query, expression: parsed.data, sort: "relevance", error: null }
    : { query, expression: null, sort: "relevance", error: "invalid" };
};
