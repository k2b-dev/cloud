import { createHash } from "node:crypto";

export const capabilityInvocationOperation = (kind: "queries" | "actions", capabilityId: string, review = false): string =>
  kind === "queries"
    ? `capability.query:${capabilityId}`
    : review
      ? `capability.action.review:${capabilityId}`
      : `capability.action.run:${capabilityId}`;

export const searchInvocationOperation = "search.query" as const;
export const widgetInvocationOperation = (widgetId: string): string => `widget.read:${widgetId}`;

/** Bind an administrative invocation to its exact target route and HTTP method. */
export const syncInvocationOperation = (method: string, path: string): string =>
  `sync.operation:${createHash("sha256").update(`${method.toUpperCase()}:${path}`).digest("hex")}`;
