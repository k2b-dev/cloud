import { flag } from "@k2b/cloud/cli";
import { METRIC_TYPES, SOURCE_KINDS } from "../contracts";

export const QUERY_INPUT = flag.input({
  name: "query",
  fileName: "file",
  fileAliases: ["f"],
  stdinName: "stdin",
  valueLabel: "query",
});

export const DASHBOARD_DSL_INPUT = flag.input({
  name: "content",
  fileName: "file",
  fileAliases: ["f"],
  stdinName: "stdin",
  valueLabel: "dsl",
});

export const JSON_INPUT = flag.input({
  name: "batch",
  fileName: "file",
  fileAliases: ["f"],
  stdinName: "stdin",
  valueLabel: "json",
});

export const bearerTokenFlags = {
  bearerTokenFile: flag.string({ name: "bearer-token-file", valueLabel: "path", description: "Read the metrics bearer token from a file" }),
  bearerTokenStdin: flag.boolean({ name: "bearer-token-stdin", description: "Read the metrics bearer token from stdin" }),
};

export const baseFlag = { base: flag.string({ description: "Pulse base ID or exact name" }) };
export const sourceKindFlag = flag.enum(SOURCE_KINDS, { name: "kind", description: "Source kind", required: true });
export const metricTypeFlag = flag.enum(METRIC_TYPES, { name: "type", description: "Metric type" });

export const sourceFilterFlags = {
  source: flag.string({ description: "Source name or ID" }),
  sourceId: flag.string({ name: "source-id", description: "Source ID" }),
};

export const resourceFilterFlags = {
  ...sourceFilterFlags,
  resource: flag.string({ description: "Resource key, ID, or label" }),
  entity: flag.string({ description: "Entity/resource ID" }),
  entityType: flag.string({ name: "entity-type", description: "Entity/resource type" }),
};

export const publicDisplayFlags = {
  theme: flag.enum(["light", "dark"] as const, { description: "Public display theme" }),
  height: flag.enum(["scroll", "full"] as const, { description: "Public display height mode" }),
};
