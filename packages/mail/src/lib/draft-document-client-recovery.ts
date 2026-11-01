import type { SharedTextOfflineIdentity } from "@k2b/cloud/browser/shared-text";

/** One immutable recovery operation per account/draft/generation and exact source bytes. */
export const draftRecoveryRequestId = async (identity: SharedTextOfflineIdentity, encodedState: string): Promise<string> => {
  // No localStorage initialization race: the same source survives tab changes and reloads.
  const input = new TextEncoder().encode(
    JSON.stringify(["mail-draft-rest-v1", identity.userId, identity.draftId, identity.generation, encodedState]),
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  // UUIDv8 carries our application-defined SHA-256 identity, with the RFC variant.
  digest[6] = (digest[6]! & 0x0f) | 0x80;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = [...digest.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
