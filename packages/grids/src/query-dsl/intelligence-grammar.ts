import { AGGREGATE_KINDS } from "../aggregate-catalog";
import type { DslQueryCompletionItem, DslQueryTextRange } from "../contracts";
import { keywordItems } from "./intelligence-core";

const TOP_LEVEL_KEYWORDS: Array<{ label: string; insertText: string; detail: string; singleton?: string }> = [
  { label: "from table", insertText: "from table ", detail: "Choose a base table", singleton: "source" },
  { label: "from view", insertText: "from view ", detail: "Use a saved view as source", singleton: "source" },
  { label: "select", insertText: "select ", detail: "Pick output fields" },
  { label: "where", insertText: "where ", detail: "Filter rows", singleton: "where" },
  { label: "join table", insertText: "join table ", detail: "Join through a relation field" },
  { label: "left join table", insertText: "left join table ", detail: "Keep source rows without a match" },
  { label: "left join view", insertText: "left join view ", detail: "Join independent grouped totals" },
  { label: "group by", insertText: "group by ", detail: "Bucket rows" },
  { label: "aggregate", insertText: "aggregate ", detail: "Calculate grouped values" },
  { label: "having", insertText: "having ", detail: "Filter grouped output", singleton: "having" },
  { label: "sort", insertText: "sort ", detail: "Order rows or groups" },
  { label: "search", insertText: "search ", detail: "Full-text search", singleton: "search" },
  { label: "limit", insertText: "limit ", detail: "Maximum rows", singleton: "limit" },
  { label: "offset", insertText: "offset ", detail: "Skip rows", singleton: "offset" },
  { label: "include deleted", insertText: "include deleted", detail: "Include trashed records", singleton: "deleted" },
  { label: "deleted only", insertText: "deleted only", detail: "Only trashed records", singleton: "deleted" },
];

const SOURCE_KIND_KEYWORDS = [
  { label: "table", insertText: "table ", detail: "Base table" },
  { label: "view", insertText: "view ", detail: "Saved view" },
];

const JOIN_KIND_KEYWORDS = [{ label: "table", insertText: "table ", detail: "Join target table" }];
export const SORT_DIRECTIONS = ["asc", "desc"];
export const NULL_MODIFIERS = ["nulls first", "nulls last"];
export const NULL_PLACEMENTS = ["first", "last"];
export const GROUP_GRANULARITIES = ["day", "week", "month", "quarter", "year"];
export const AGGREGATE_FUNCTIONS = AGGREGATE_KINDS;
export const PREDICATE_FUNCTIONS = [
  { label: "oneof", insertText: "oneof(", detail: "Membership: field equals one listed value" },
  { label: "noneof", insertText: "noneof(", detail: "Membership: field equals none of the listed values" },
  { label: "containsall", insertText: "containsall(", detail: "Multi-value field contains every listed value" },
  { label: "contains", insertText: "contains(", detail: "Case-sensitive text contains" },
  { label: "startswith", insertText: "startswith(", detail: "Case-sensitive text prefix" },
  { label: "endswith", insertText: "endswith(", detail: "Case-sensitive text suffix" },
  { label: "icontains", insertText: "icontains(", detail: "Case-insensitive text contains" },
  { label: "istartswith", insertText: "istartswith(", detail: "Case-insensitive text prefix" },
  { label: "iendswith", insertText: "iendswith(", detail: "Case-insensitive text suffix" },
];
export const PREDICATE_OPERATORS = [
  { label: "and", insertText: "and ", detail: "Boolean AND" },
  { label: "or", insertText: "or ", detail: "Boolean OR" },
  { label: "not", insertText: "not ", detail: "Boolean NOT" },
];
export const PREDICATE_COMPARISON_OPERATORS = [
  { label: "=", insertText: "= ", detail: "equals" },
  { label: "!=", insertText: "!= ", detail: "does not equal" },
  { label: ">", insertText: "> ", detail: "greater than" },
  { label: ">=", insertText: ">= ", detail: "greater than or equal" },
  { label: "<", insertText: "< ", detail: "less than" },
  { label: "<=", insertText: "<= ", detail: "less than or equal" },
];
export const PREDICATE_JOIN_OPERATORS = PREDICATE_OPERATORS.filter((item) => item.label !== "not");

export const SOURCE_REF_RE = String.raw`(?:\{[^}\r\n]+\}|"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_]*|[0-9A-Fa-f-]{8,})`;
export const QUALIFIED_REF_RE = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*\.)?${SOURCE_REF_RE}`;
export const SEARCH_QUOTED_RE = /^'((?:\\.|[^'\\])*)'/;

const usedSingletonClauses = (query: string) => {
  const lower = query.toLowerCase();
  return {
    source: /\bfrom\s+/.test(lower),
    where: /\bwhere\s+/.test(lower),
    having: /\bhaving\s+/.test(lower),
    search: /\bsearch\s+/.test(lower),
    limit: /\blimit\s+/.test(lower),
    offset: /\boffset\s+/.test(lower),
    deleted: /\binclude\s+deleted\b|\bdeleted\s+only\b/.test(lower),
  };
};

export const topLevelSuggestions = (query: string, range: DslQueryTextRange): DslQueryCompletionItem[] => {
  const used = usedSingletonClauses(query);
  const items = TOP_LEVEL_KEYWORDS.filter((item) => !item.singleton || !used[item.singleton as keyof typeof used]);
  return keywordItems(query, range, items);
};

export const sourceKindSuggestions = (query: string, range: DslQueryTextRange, join = false): DslQueryCompletionItem[] =>
  keywordItems(query, range, join ? JOIN_KIND_KEYWORDS : SOURCE_KIND_KEYWORDS);
