import { sql } from "@k2b/cloud";
import { listResourceManagers } from "@k2b/cloud/capabilities/server";
import type { CapabilityAppExecutionContext, ResourcePrincipal, ResourceReadableInput } from "@k2b/cloud/contracts";
import { appEvents } from "@k2b/cloud/events";
import { getEffectivePermissions } from "@k2b/cloud/server";
import { listApprovalAdminRecipients } from "@k2b/cloud/services/approvals";
import { resolveResourceReaders } from "@k2b/cloud/services/identity";
import { z } from "zod";
import { findCode } from "./store";

/** Project current domain grants, never a recipient's session. In particular an owner
 * in another app must be checked with workload authority, not a synthetic invocation. */
export async function readableCodePrincipals(input: ResourceReadableInput, context: CapabilityAppExecutionContext) {
  const code = await findCode(input.id);
  if (!code || code.state === "deleting") return [];
  const readers = await resolveResourceReaders(input.principals);
  const subjects = readers.map((reader) => reader.subject);
  const shares = await getEffectivePermissions({
    accessIds: sql`SELECT access_id FROM code.shares WHERE code_id=${code.id}`,
    subjects,
  });
  const appGrants =
    code.owner.kind === "app"
      ? await getEffectivePermissions({ accessIds: sql`SELECT access_id FROM auth.app_access WHERE app_id=${code.owner.appId}`, subjects })
      : [];
  const readable: ResourcePrincipal[] = [];
  for (const [index, reader] of readers.entries()) {
    context.signal.throwIfAborted();
    // The ordinary Code reader requires a person, including a user-delegated account.
    if (reader.subject.type !== "user") continue;
    const userId = reader.subject.userId;
    if (
      (shares[index] && shares[index] !== "none") ||
      appGrants[index] === "admin" ||
      (code.owner.kind === "person" && code.owner.userId === userId) ||
      (await listApprovalAdminRecipients(sql, { userId, limit: 1 })).length ||
      (code.owner.kind === "resource" &&
        (await listResourceManagers({ ref: code.owner.ref, userId, limit: 1, signal: context.signal })).includes(userId))
    )
      readable.push(reader.principal);
  }
  return readable;
}

/** A private decision is a resource event. Its place reader is checked for every subscription delivery. */
export const codeReviewEvents = {
  "code.version.decided": {
    version: 1,
    title: "Code version decided",
    description: "A Cloud admin decided an immutable Code version. Read its message through review.",
    subject: "code",
    place: "code",
    schema: z
      .object({
        codeId: z.string().min(1).max(32),
        versionId: z.uuid(),
        number: z.number().int().positive(),
        outcome: z.enum(["approved", "changes_requested", "rejected"]),
      })
      .strict(),
  },
} as const;
export const codeReviewEventPublisher = appEvents<{ protocolVersion: 2; events: typeof codeReviewEvents }>("core");
