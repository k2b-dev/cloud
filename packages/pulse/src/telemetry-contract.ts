export const PULSE_DIMENSION_KEY_LIMIT = 32;
export const PULSE_DIMENSION_KEY_MAX_LENGTH = 80;
export const PULSE_DIMENSION_VALUE_MAX_LENGTH = 500;
export const PULSE_EVENT_ATTRIBUTE_KEY_LIMIT = 64;
export const PULSE_EVENT_ATTRIBUTE_KEY_MAX_LENGTH = 80;
export const PULSE_EVENT_ATTRIBUTES_MAX_BYTES = 32 * 1024;
export const PULSE_EVENT_ATTRIBUTES_MAX_DEPTH = 4;
export const PULSE_EVENT_SENSITIVE_KEY_LIMIT = 32;
export const PULSE_EVENT_SENSITIVE_MAX_BYTES = 32 * 1024;
export const PULSE_EVENT_SENSITIVE_MAX_DEPTH = 4;
export const PULSE_EVENT_PAYLOAD_MAX_BYTES = 64 * 1024;
export const PULSE_EVENT_PAYLOAD_MAX_DEPTH = 8;
export const PULSE_EXTERNAL_INGEST_MAX_BYTES = 5 * 1024 * 1024;
export const PULSE_RESOURCE_KEY_MAX_LENGTH = 505;

export const validateResourceIdentity = (type: string, id: string): string | null => {
  if (!/^[a-z][a-z0-9._-]*$/.test(type)) return "Resource type must be a lowercase slug";
  if (!id.trim()) return "Resource id cannot be empty";
  return `${type}:${id}`.length > PULSE_RESOURCE_KEY_MAX_LENGTH
    ? `Resource key cannot exceed ${PULSE_RESOURCE_KEY_MAX_LENGTH} characters`
    : null;
};

export const jsonBytes = (value: unknown): number | null => {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return null;
  }
};

export type PulseTelemetryValueKind = "null" | "string" | "number" | "boolean" | "object" | "array";

export const telemetryValueKind = (value: unknown): PulseTelemetryValueKind => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      throw new TypeError("Telemetry values must be JSON compatible");
  }
};

const objectDepth = (value: unknown, depth = 0): number => {
  if (value === null || typeof value !== "object") return depth;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.reduce((max, child) => Math.max(max, objectDepth(child, depth + 1)), depth);
};

export const validateDimensions = (dimensions: Record<string, unknown> | undefined): string | null => {
  const entries = Object.entries(dimensions ?? {});
  if (entries.length > PULSE_DIMENSION_KEY_LIMIT) return `Dimensions cannot exceed ${PULSE_DIMENSION_KEY_LIMIT} keys`;
  for (const [key, value] of entries) {
    if (!key.trim()) return "Dimension keys cannot be empty";
    if (key.length > PULSE_DIMENSION_KEY_MAX_LENGTH) return `Dimension keys cannot exceed ${PULSE_DIMENSION_KEY_MAX_LENGTH} characters`;
    if (value !== null && String(value).length > PULSE_DIMENSION_VALUE_MAX_LENGTH)
      return `Dimension values cannot exceed ${PULSE_DIMENSION_VALUE_MAX_LENGTH} characters`;
  }
  return null;
};

const validateJsonObject = (
  label: string,
  value: Record<string, unknown> | undefined,
  limits: { maxKeys?: number; maxBytes: number; maxDepth: number },
): string | null => {
  const object = value ?? {};
  if (limits.maxKeys !== undefined && Object.keys(object).length > limits.maxKeys)
    return `${label} cannot exceed ${limits.maxKeys} top-level keys`;
  const byteLength = jsonBytes(object);
  if (byteLength === null) return `${label} must be valid JSON`;
  const encoded = JSON.stringify(object);
  if (byteLength > limits.maxBytes) return `${label} cannot exceed ${limits.maxBytes} bytes`;
  if (objectDepth(JSON.parse(encoded)) > limits.maxDepth) return `${label} cannot exceed ${limits.maxDepth} nested levels`;
  return null;
};

export const validateEventAttributes = (attributes: Record<string, unknown> | undefined): string | null =>
  Object.keys(attributes ?? {}).some((key) => !key.trim() || key.length > PULSE_EVENT_ATTRIBUTE_KEY_MAX_LENGTH)
    ? `Event attribute keys must be non-empty and cannot exceed ${PULSE_EVENT_ATTRIBUTE_KEY_MAX_LENGTH} characters`
    : validateJsonObject("Event attributes", attributes, {
        maxKeys: PULSE_EVENT_ATTRIBUTE_KEY_LIMIT,
        maxBytes: PULSE_EVENT_ATTRIBUTES_MAX_BYTES,
        maxDepth: PULSE_EVENT_ATTRIBUTES_MAX_DEPTH,
      });

export const validateEventSensitive = (sensitive: Record<string, unknown> | undefined): string | null =>
  Object.keys(sensitive ?? {}).some((key) => !key.trim() || key.length > PULSE_EVENT_ATTRIBUTE_KEY_MAX_LENGTH)
    ? `Sensitive event keys must be non-empty and cannot exceed ${PULSE_EVENT_ATTRIBUTE_KEY_MAX_LENGTH} characters`
    : validateJsonObject("Sensitive event data", sensitive, {
        maxKeys: PULSE_EVENT_SENSITIVE_KEY_LIMIT,
        maxBytes: PULSE_EVENT_SENSITIVE_MAX_BYTES,
        maxDepth: PULSE_EVENT_SENSITIVE_MAX_DEPTH,
      });

export const validateEventPayload = (payload: Record<string, unknown> | undefined): string | null =>
  validateJsonObject("Event payload", payload, {
    maxBytes: PULSE_EVENT_PAYLOAD_MAX_BYTES,
    maxDepth: PULSE_EVENT_PAYLOAD_MAX_DEPTH,
  });
