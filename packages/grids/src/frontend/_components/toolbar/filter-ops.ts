import type { PublicField as Field } from "../../../api/public-dto";
import { toolbarMessages } from "./messages";

export type FilterOp = {
  /** Op identifier sent to the API. */
  id: string;
  /** Human label shown in the dropdown. */
  label: string;
  /** Icon shown in rich select dropdowns. */
  icon?: string;
  /** Short help text shown under the label. */
  description?: string;
  /** True if this op needs a value input. `between` needs two; we render them inline. */
  needsValue: boolean;
  /** True if this op needs two value inputs (`between`). */
  needsRange?: boolean;
};

// Op labels are tightened (no "is " prefix, "doesn't contain" → "not contains")
// because the filter row already reads "where {field} {op} {value}", so the
// implicit "is" is obvious from context. Backend op `id`s stay the same.
const TEXT_OPS: FilterOp[] = [
  { id: "equals", label: "is", icon: "ti ti-equal", description: "Exact text match", needsValue: true },
  { id: "notEquals", label: "is not", icon: "ti ti-equal-not", description: "Different text", needsValue: true },
  { id: "contains", label: "contains", icon: "ti ti-search", description: "Includes this text", needsValue: true },
  { id: "notContains", label: "not contains", icon: "ti ti-search-off", description: "Does not include this text", needsValue: true },
  { id: "startsWith", label: "starts with", icon: "ti ti-arrow-bar-right", description: "Begins with this text", needsValue: true },
  { id: "endsWith", label: "ends with", icon: "ti ti-arrow-bar-left", description: "Ends with this text", needsValue: true },
  { id: "regex", label: "regex", icon: "ti ti-regex", description: "Matches a regex pattern", needsValue: true },
  { id: "isEmpty", label: "empty", icon: "ti ti-circle-dashed", description: "No stored value", needsValue: false },
  { id: "isNotEmpty", label: "not empty", icon: "ti ti-circle-check", description: "Has a stored value", needsValue: false },
];

const NUMBER_OPS: FilterOp[] = [
  { id: "=", label: "equals", icon: "ti ti-equal", needsValue: true },
  { id: "!=", label: "not equal", icon: "ti ti-equal-not", needsValue: true },
  { id: "<", label: "less than", icon: "ti ti-math-lower", needsValue: true },
  { id: "<=", label: "less than or equal", icon: "ti ti-math-equal-lower", needsValue: true },
  { id: ">", label: "greater than", icon: "ti ti-math-greater", needsValue: true },
  { id: ">=", label: "greater than or equal", icon: "ti ti-math-equal-greater", needsValue: true },
  {
    id: "between",
    label: "between",
    icon: "ti ti-circle-plus-minus",
    description: "Inside a value range",
    needsValue: true,
    needsRange: true,
  },
  { id: "isEmpty", label: "empty", icon: "ti ti-circle-dashed", description: "No stored value", needsValue: false },
  { id: "isNotEmpty", label: "not empty", icon: "ti ti-circle-check", description: "Has a stored value", needsValue: false },
];

const DATE_OPS: FilterOp[] = [
  { id: "=", label: "is", icon: "ti ti-calendar", description: "Same date", needsValue: true },
  { id: "before", label: "before", icon: "ti ti-calendar-minus", description: "Earlier than this date", needsValue: true },
  { id: "after", label: "after", icon: "ti ti-calendar-plus", description: "Later than this date", needsValue: true },
  { id: "between", label: "between", icon: "ti ti-calendar-stats", description: "Inside a date range", needsValue: true, needsRange: true },
  { id: "today", label: "today", icon: "ti ti-calendar-event", description: "Falls on today", needsValue: false },
  { id: "thisWeek", label: "this week", icon: "ti ti-calendar-week", description: "Falls in this week", needsValue: false },
  { id: "thisMonth", label: "this month", icon: "ti ti-calendar-month", description: "Falls in this month", needsValue: false },
  { id: "lastNDays", label: "last N days", icon: "ti ti-history", description: "Within the last N days", needsValue: true },
  { id: "isEmpty", label: "empty", icon: "ti ti-circle-dashed", description: "No stored value", needsValue: false },
  { id: "isNotEmpty", label: "not empty", icon: "ti ti-circle-check", description: "Has a stored value", needsValue: false },
];

const BOOL_OPS: FilterOp[] = [
  { id: "=", label: "is", icon: "ti ti-checkbox", description: "True or false", needsValue: true },
  { id: "isEmpty", label: "empty", icon: "ti ti-circle-dashed", description: "No stored value", needsValue: false },
  { id: "isNotEmpty", label: "not empty", icon: "ti ti-circle-check", description: "Has a stored value", needsValue: false },
];

const SELECT_OPS: FilterOp[] = [
  { id: "is", label: "is", icon: "ti ti-tag", description: "Selected option", needsValue: true },
  { id: "isNot", label: "is not", icon: "ti ti-tag-off", description: "Any other option", needsValue: true },
  { id: "isAnyOf", label: "one of", icon: "ti ti-list-check", description: "Any selected option matches", needsValue: true },
  { id: "isNoneOf", label: "none of", icon: "ti ti-tags-off", description: "No selected option matches", needsValue: true },
  { id: "isEmpty", label: "empty", icon: "ti ti-circle-dashed", description: "No selected option", needsValue: false },
  { id: "isNotEmpty", label: "not empty", icon: "ti ti-circle-check", description: "Has a selected option", needsValue: false },
];

const RELATION_OPS: FilterOp[] = [
  { id: "containsAny", label: "contains", icon: "ti ti-link", description: "Links to any selected record", needsValue: true },
  { id: "isEmpty", label: "empty", icon: "ti ti-circle-dashed", description: "No linked record", needsValue: false },
  { id: "isNotEmpty", label: "not empty", icon: "ti ti-circle-check", description: "Has a linked record", needsValue: false },
];

const PRINCIPAL_OPS: FilterOp[] = [
  { id: "containsAny", label: "contains", icon: "ti ti-users", description: "Includes any selected user or group", needsValue: true },
  {
    id: "notContainsAny",
    label: "does not contain",
    icon: "ti ti-users-minus",
    description: "Includes none of the selected identities",
    needsValue: true,
  },
  { id: "isEmpty", label: "empty", icon: "ti ti-circle-dashed", description: "No assigned user or group", needsValue: false },
  { id: "isNotEmpty", label: "not empty", icon: "ti ti-circle-check", description: "Has an assigned user or group", needsValue: false },
];

export const opsForType = (type: string): FilterOp[] => {
  switch (type) {
    case "text":
    case "id":
    case "longtext":
      return TEXT_OPS;
    case "number":
    case "percent":
    case "duration":
      return NUMBER_OPS;
    case "date":
      return DATE_OPS;
    case "boolean":
      return BOOL_OPS;
    case "select":
      return SELECT_OPS;
    case "relation":
      return RELATION_OPS;
    case "principal":
      return PRINCIPAL_OPS;
    // json: opaque to filter — no ops surfaced.
    default:
      return [];
  }
};

/** Locale-aware presentation of the stable filter operation contract. */
export const localizedOpsForType = (type: string, locale: string): FilterOp[] => {
  const t = toolbarMessages.resolve([locale]).t;
  const labels: Record<string, [string, string?]> = {
    equals: [t.is, t.exactText],
    notEquals: [t.isNot, t.differentText],
    contains: [t.contains, t.includesText],
    notContains: [t.doesNotContain, t.excludesText],
    startsWith: [t.startsWith, t.beginsText],
    endsWith: [t.endsWith, t.endsText],
    regex: [t.regex, t.regexDescription],
    "!=": [t.notEqual],
    "<": [t.lessThan],
    "<=": [t.lessThanEqual],
    ">": [t.greaterThan],
    ">=": [t.greaterThanEqual],
    before: [t.before, t.earlierDate],
    after: [t.after, t.laterDate],
    today: [t.today, t.fallsToday],
    thisWeek: [t.thisWeek, t.fallsThisWeek],
    thisMonth: [t.thisMonth, t.fallsThisMonth],
    lastNDays: [t.lastNDays, t.withinLastDays],
    is: [t.is, t.selectedOption],
    isNot: [t.isNot, t.otherOption],
    isAnyOf: [t.oneOf, t.anyOptionMatches],
    isNoneOf: [t.noneOf, t.noOptionMatches],
    notContainsAny: [t.doesNotContain, t.excludesIdentities],
  };
  return opsForType(type).map((op) => {
    if (op.id === "=") {
      if (type === "number" || type === "percent" || type === "duration") return { ...op, label: t.equals };
      if (type === "date") return { ...op, label: t.is, description: t.sameDate };
      return { ...op, label: t.is, description: t.trueOrFalse };
    }
    if (op.id === "between") {
      return { ...op, label: t.between, description: type === "date" ? t.insideDateRange : t.insideValueRange };
    }
    if (op.id === "isEmpty") {
      const description =
        type === "select"
          ? t.noSelectedOption
          : type === "relation"
            ? t.noLinkedRecord
            : type === "principal"
              ? t.noAssignedIdentity
              : t.noStoredValue;
      return { ...op, label: t.empty, description };
    }
    if (op.id === "isNotEmpty") {
      const description =
        type === "select"
          ? t.hasSelectedOption
          : type === "relation"
            ? t.hasLinkedRecord
            : type === "principal"
              ? t.hasAssignedIdentity
              : t.hasStoredValue;
      return { ...op, label: t.notEmpty, description };
    }
    if (op.id === "containsAny") {
      return { ...op, label: t.contains, description: type === "relation" ? t.linksSelectedRecord : t.includesIdentity };
    }
    const localized = labels[op.id];
    return localized ? { ...op, label: localized[0], description: localized[1] } : op;
  });
};

/**
 * Returns true if a field type can be filtered via the UI. System fields
 * and unsupported types fall through.
 */
const isFilterable = (type: string): boolean => opsForType(type).length > 0;

/**
 * Filter fields available for the filter UI. Excludes deleted fields and
 * types the field-filter UI does not support. Record metadata has its own
 * query controls because those values are stored on records, not fields.
 */
export const filterableFields = (fields: Field[]): Field[] => fields.filter((f) => !f.deletedAt && isFilterable(f.type));
