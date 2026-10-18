import type { WorkflowJsonValue } from "@k2b/cloud/workflows";

type JsonObject = Record<string, WorkflowJsonValue>;
export type MailBodyField = "body" | "bodyText" | "bodyHtml";
const BODY_FIELDS: readonly MailBodyField[] = ["body", "bodyText", "bodyHtml"];

// Body fields this run has loaded into a projected message. Aliased inputs share the object, so the
// marks hold for every input name; a loaded body may be "".
const loadedBodyFields = new WeakMap<JsonObject, Set<MailBodyField>>();

export const mailWorkflowBodyFieldLoaded = (message: JsonObject, field: MailBodyField): boolean =>
  message.bodyAvailable === true || (loadedBodyFields.get(message)?.has(field) ?? false);

export const markMailWorkflowBodyFieldsLoaded = (message: JsonObject, fields: readonly MailBodyField[]): void => {
  const loaded = loadedBodyFields.get(message) ?? new Set<MailBodyField>();
  loadedBodyFields.set(message, loaded);
  for (const field of fields) loaded.add(field);
  if (loaded.size === BODY_FIELDS.length) message.bodyAvailable = true;
};

/**
 * Runs a synchronous template render while every body field Mail has not loaded yet throws on read.
 * Returns the first such reference, so a caller can load it or fail instead of rendering "".
 */
export const withMailWorkflowBodyGuard = <T>(
  inputs: Record<string, WorkflowJsonValue>,
  render: () => T,
): { result: T; unloaded?: undefined } | { result?: undefined; unloaded: string } => {
  const notLoaded = Symbol("Mail workflow body not loaded");
  const messages = new Map<JsonObject, string>();
  for (const [name, value] of Object.entries(inputs)) {
    const isMessage = value !== null && typeof value === "object" && !Array.isArray(value) && value.bodyAvailable === false;
    if (isMessage && !messages.has(value)) messages.set(value, name);
  }
  let unloaded: string | undefined;
  const restore: Array<() => void> = [];
  try {
    for (const [message, name] of messages) {
      for (const field of BODY_FIELDS) {
        if (mailWorkflowBodyFieldLoaded(message, field)) continue;
        const value = message[field];
        Object.defineProperty(message, field, {
          enumerable: true,
          configurable: true,
          get: () => {
            unloaded ??= `inputs.${name}.${field}`;
            throw notLoaded;
          },
        });
        restore.push(() => Object.defineProperty(message, field, { value, writable: true, enumerable: true, configurable: true }));
      }
    }
    // Renderers wrap the thrown sentinel; the local reference identifies it without inspecting errors.
    const result = render();
    return unloaded === undefined ? { result } : { unloaded };
  } finally {
    for (const field of restore) field();
  }
};
