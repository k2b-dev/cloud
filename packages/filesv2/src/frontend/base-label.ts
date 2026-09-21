import type { BaseKind } from "../contracts";

/**
 * Presentation name of a storage location. `name` stays the technical name used by the API and CLI;
 * the personal base reads "My files" so it is not mistaken for a group of the same name.
 */
export const baseLabel = (base: { name: string; kind?: BaseKind }, messages: { myFiles: string }) =>
  base.kind === "users" ? messages.myFiles : base.name;
