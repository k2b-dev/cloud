/** Durable bridge classification for a failed admitted Code call. Safe for browser and CLI contracts. */
export const CODE_BRIDGE_REFUSAL_KINDS = ["target_refused", "policy", "approval", "app_not_allowed", "bridge"] as const;
export type CodeBridgeRefusalKind = (typeof CODE_BRIDGE_REFUSAL_KINDS)[number];
