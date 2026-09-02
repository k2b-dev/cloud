export const capabilityInvocationOperation = (kind: "queries" | "actions", capabilityId: string, review = false): string =>
  kind === "queries"
    ? `capability.query:${capabilityId}`
    : review
      ? `capability.action.review:${capabilityId}`
      : `capability.action.run:${capabilityId}`;

export const searchInvocationOperation = "search.query" as const;
export const widgetInvocationOperation = (widgetId: string): string => `widget.read:${widgetId}`;
