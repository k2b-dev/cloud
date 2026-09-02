export const PRESENTATION_MODES = ["book", "write", "readonly"] as const;

export type PresentationMode = (typeof PRESENTATION_MODES)[number];

export const isPresentationMode = (value: unknown): value is PresentationMode =>
  value === "book" || value === "write" || value === "readonly";

/** Presentation never grants access; callers must authorize the notebook first. */
export const resolvePresentationMode = (params: {
  permission: string;
  defaultPresentationMode: PresentationMode;
  requestedMode?: unknown;
  locked?: boolean;
}): PresentationMode => {
  if (params.permission !== "write" && params.permission !== "admin") return "book";
  const mode = isPresentationMode(params.requestedMode) ? params.requestedMode : params.defaultPresentationMode;
  return mode === "write" && params.locked ? "readonly" : mode;
};
