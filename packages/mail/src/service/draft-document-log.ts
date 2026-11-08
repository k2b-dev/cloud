import { sharedText } from "@k2b/cloud/shared-text";

export const MAX_LOG_ENVELOPE_BYTES = 8_100_000 + 4096;

/**
 * Preparation only: lock remains the default. Sync #4 (reject-full, no expiry
 * before snapshot coverage, watermark pruning) blocks activation. These are
 * supported Sync 7 settings, using the existing Notebooks budget: 1 GiB holds
 * about 149 KiB/s for a two-hour stalled projection window, or 132 maximum
 * updates. The unused dead-letter stream has room for two maximum envelopes.
 * Merely importing this declaration does not provision or activate a log.
 */
export const mailDraftDocumentLog = sharedText.define({
  id: "cloud:mail:draft-documents",
  retention: { maxAgeMs: 7 * 24 * 60 * 60 * 1000, maxBytes: 1024 ** 3 },
  deadLetterRetention: { maxBytes: 16 * 1024 * 1024 },
  maxPayloadBytes: MAX_LOG_ENVELOPE_BYTES,
});
