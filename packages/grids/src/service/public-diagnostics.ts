// Diagnostics are not user data. Storage identifiers must not escape through
// errors when the referenced resource no longer exists (and cannot be mapped).
const PRIVATE_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export const publicDiagnosticMessage = (message: string): string => message.replace(PRIVATE_UUID, "…");

export const publicDiagnosticValue = (value: unknown): unknown => {
  if (typeof value === "string") return publicDiagnosticMessage(value);
  if (Array.isArray(value)) return value.map(publicDiagnosticValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [publicDiagnosticMessage(key), publicDiagnosticValue(item)]));
};
