import { z } from "zod";
import { type PreviewSourceKind, type PreviewVariant, previewSourceKind } from "../../shared/previews";

export type PreviewSource = { key: string; revision: string; name: string; mediaType?: string; size: number; locator: string };
export type PreviewReader = (
  source: Pick<PreviewSource, "key" | "revision" | "locator">,
  signal: AbortSignal,
) => Promise<ReadableStream<Uint8Array> | Response>;
export type PreviewState = "ready" | "failed" | "too_large" | "unsupported";
export type PreviewReadResult =
  | { state: "ready"; body: ReadableStream<Uint8Array> | Blob; type: string; bytes: number }
  | { state: "pending"; retryAfter: number }
  | { state: "failed" | "too_large" | "unsupported" };
export class PreviewSourceChanged extends Error {
  constructor() {
    super("Preview source changed");
    this.name = "PreviewSourceChanged";
  }
}
export class PreviewGenerationError extends Error {
  constructor(
    public readonly state: "failed" | "too_large" | "unsupported",
    public readonly code: string,
  ) {
    super(code);
  }
}
const boundedString = (max: number) =>
  z
    .string()
    .min(1)
    .refine((value) => new TextEncoder().encode(value).byteLength <= max);
export const PreviewSourceSchema = z.object({
  key: boundedString(512),
  revision: boundedString(256),
  locator: boundedString(2048),
  name: z.string().min(1).max(1024),
  mediaType: z.string().max(256).optional(),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export const PREVIEW_LIMITS = { image: 32 * 1024 ** 2, pdf: 50_000_000, office: 20_000_000, text: 2048 } as const;
export const PREVIEW_DEADLINE_MS = 180_000;
export const pending = (): PreviewReadResult => ({ state: "pending", retryAfter: 2 });
export const supportsVariant = (kind: PreviewSourceKind, variant: PreviewVariant) =>
  kind === "text" ? variant === "text" : variant === "small" || variant === "large" || (kind === "office" && variant === "pdf");
export function sourceState(source: PreviewSource): { kind: PreviewSourceKind } | { state: "unsupported" | "too_large" } {
  const kind = previewSourceKind(source.name, source.mediaType);
  if (!kind) return { state: "unsupported" };
  if (kind !== "text" && source.size > PREVIEW_LIMITS[kind]) return { state: "too_large" };
  return { kind };
}
export type PreviewArtifacts = Partial<Record<PreviewVariant, Blob>>;
export type PreviewManifest = Partial<Record<PreviewVariant, { type: string; bytes: number }>>;
