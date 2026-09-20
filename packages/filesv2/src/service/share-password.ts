import { secrets } from "@k2b/cloud/services";
import { crypto } from "@k2b/stdlib";
import { z } from "zod";
import type { ShareRow } from "../data/shares";
import { FilesError } from "./errors";

export const SHARE_ACCESS_SECONDS = 12 * 60 * 60;
const Access = z.object({ purpose: z.literal("filesv2-share-access"), id: z.string(), verifier: z.string(), expires: z.number() }).strict();

export async function hashSharePassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });
}
export async function unlockSharePassword(row: Pick<ShareRow, "id" | "password_hash">, password: string): Promise<string> {
  if (!row.password_hash || !(await Bun.password.verify(password, row.password_hash))) throw new FilesError("share_password_invalid", 403);
  return secrets.encrypt({
    purpose: "filesv2-share-access",
    id: row.id,
    verifier: await crypto.common.hash(row.password_hash),
    expires: Date.now() + SHARE_ACCESS_SECONDS * 1000,
  });
}
export async function requireSharePassword(row: Pick<ShareRow, "id" | "password_hash">, access?: string): Promise<void> {
  if (!row.password_hash) return;
  if (access && access.length <= 4096) {
    try {
      const grant = Access.parse(await secrets.decrypt(access));
      if (grant.id === row.id && grant.expires > Date.now() && grant.verifier === (await crypto.common.hash(row.password_hash))) return;
    } catch {
      /* Invalid, expired or foreign proofs never unlock a share. */
    }
  }
  throw new FilesError("share_password_required", 403);
}
