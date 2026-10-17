// Shared by the intake and the lazily loaded HEIF decoder, which must not import the intake back.
export type ImageIntakeFailure = { reason: "unsupported" | "too-large" | "decode-failed" | "decoder-unavailable" };
export class ImageIntakeError extends Error {
  constructor(public readonly reason: ImageIntakeFailure["reason"]) {
    super(reason);
    this.name = "ImageIntakeError";
  }
}
export type ImageIntakeStage = "waiting" | "loading-decoder" | "decoding";
export type IntakeOptions = { signal: AbortSignal; onStage: (stage: ImageIntakeStage) => void };
export type HeifOptions = IntakeOptions & { maxPixels: number };
