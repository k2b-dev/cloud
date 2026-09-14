export const VISUALS = new Set(["line", "bar", "stat", "gauge", "barGauge", "histogram", "heatmap", "table"]);
export const MAP_FIELD_ROLES = new Set(["dimension", "attribute"]);
export const MAP_SIZE_MODES = new Set(["count", "sum"]);
export const CONTROL_KINDS = new Set(["range", "source", "resource", "resource_type", "label", "text"]);
export const CONDITION_LEVELS = new Set(["warn", "critical"]);
export const CONDITION_OPERATORS = new Set([">", ">=", "<", "<=", "=", "!="]);
export const STATE_WIDGET_VISUALS: ReadonlySet<string> = new Set(["table", "stat"]);
