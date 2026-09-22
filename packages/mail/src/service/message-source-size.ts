export type MessageSourceSizeVerdict = { kind: "match" } | { kind: "advisory_mismatch"; expectedSize: number; byteLength: number };

// RFC822.SIZE is a server-computed number that IMAP providers do not always
// derive from the octets they later deliver in BODY[]: Gmail is known to count
// line endings and 8-bit content differently from the message it serves. The
// IMAP literal framing already guarantees that the delivered stream is exactly
// what the server sent, and a transport failure surfaces as a stream error, so
// the advertised size is advisory. Only an empty delivery against a non-empty
// announcement is a certain truncation.
export const assessMessageSourceSize = (byteLength: number, expectedSize: number | null | undefined): MessageSourceSizeVerdict => {
  if (expectedSize == null || expectedSize < 0 || byteLength === expectedSize) return { kind: "match" };
  if (byteLength === 0) {
    throw Object.assign(new Error("Message source delivered no bytes although the provider announced some"), {
      code: "MESSAGE_SIZE_MISMATCH",
      expectedSize,
      byteLength,
    });
  }
  return { kind: "advisory_mismatch", expectedSize, byteLength };
};
