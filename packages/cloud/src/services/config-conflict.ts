export class ConfigConflict extends Error {
  readonly code = "conflict";
  constructor(
    readonly current: unknown,
    readonly changedBy: { id: string; name: string } | null,
    readonly changedAt: string,
    readonly key?: string,
  ) {
    super("This configuration changed. Read the current version before saving.");
  }
}
