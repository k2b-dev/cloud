const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function isPanelReadyMessage(value: unknown, provider: string): value is { type: "cloud.panel.ready"; v: 1; provider: string } {
  return (
    isRecord(value) &&
    Reflect.ownKeys(value).length === 3 &&
    Object.hasOwn(value, "type") &&
    Object.hasOwn(value, "v") &&
    Object.hasOwn(value, "provider") &&
    value.type === "cloud.panel.ready" &&
    value.v === 1 &&
    typeof value.provider === "string" &&
    value.provider === provider
  );
}

export function isPanelCloseMessage(value: unknown): value is { type: "cloud.panel.close"; v?: 1 } {
  return (
    isRecord(value) &&
    Object.hasOwn(value, "type") &&
    value.type === "cloud.panel.close" &&
    (Reflect.ownKeys(value).length === 1 || (Reflect.ownKeys(value).length === 2 && Object.hasOwn(value, "v") && value.v === 1))
  );
}
