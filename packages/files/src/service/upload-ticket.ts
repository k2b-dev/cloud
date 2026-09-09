import { timingSafeEqual } from "node:crypto";
import { env } from "@k2b/cloud/config";

/**
 * Upload tickets bind a chunked-upload session to the base it was started in.
 *
 * Filegate derives its upload id as `sha256(path:filename:checksum)` truncated
 * to 16 hex characters, and the chunk endpoint trusts whatever id it is handed.
 * The id is therefore both guessable and unauthenticated: a caller who knows a
 * target path, filename and file checksum can compute the id of somebody else's
 * in-flight upload and write chunks into it.
 *
 * Verifying the base named in the chunk URL does not help, because that base is
 * the caller's own. What has to be proven is that the *session* belongs to a
 * base the caller may write to. The ticket carries that proof: it is issued
 * alongside the upload id when the session starts — at which point the base has
 * been authorized — and re-checked on every chunk.
 */

const ticketFor = (params: { uploadId: string; baseType: string; baseId: string }): string =>
  new Bun.CryptoHasher("sha256", env.APP_SECRET)
    .update(`files.upload:${params.uploadId}:${params.baseType}:${params.baseId}`)
    .digest("hex");

/** Issue a ticket for a session whose base has just been authorized. */
export const signUploadTicket = ticketFor;

/** Check a ticket against the base the caller is authorized for. */
export const verifyUploadTicket = (params: { uploadId: string; baseType: string; baseId: string; ticket: string }): boolean => {
  const expected = Buffer.from(ticketFor(params), "utf8");
  const received = Buffer.from(params.ticket, "utf8");
  // timingSafeEqual throws on a length mismatch, which a caller controls.
  return expected.length === received.length && timingSafeEqual(expected, received);
};
