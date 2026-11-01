import { CodeAccessTargetSchema } from "@k2b/cloud/contracts";
import { z } from "zod";
import { CodeIdSchema } from "./contracts";

/** Pending durable cleanup for Administration › Code (C22). Completed jobs disappear.
 * waiting means retry is automatic; lastError is a stable code, never a remote error body.
 * A code.delete job waits until every code.access.rm job has completed.
 */
export const CodeCleanupJobSchema = z
  .object({
    id: z.uuid(),
    codeId: CodeIdSchema,
    title: z.string(),
    kind: z.enum(["code.access.rm", "code.delete"]),
    grantId: z.uuid().nullable(),
    target: CodeAccessTargetSchema.nullable(),
    state: z.enum(["pending", "running", "waiting"]),
    attempts: z.number().int().nonnegative(),
    lastError: z.string().nullable(),
    nextAttemptAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type CodeCleanupJob = z.infer<typeof CodeCleanupJobSchema>;
/** Cloud-admin-only, bounded cleanup read model; cursor is the previous nextCursor. */
export const codeLifecycleContracts = {
  cleanup: {
    input: z
      .object({
        codeId: CodeIdSchema.optional().describe("Filter pending cleanup by one Code ID."),
        cursor: z.uuid().optional().describe("Opaque nextCursor of the previous page."),
        limit: z.number().int().min(1).max(50).default(20).describe("Maximum pending jobs in this page."),
      })
      .strict(),
    data: z.object({ items: z.array(CodeCleanupJobSchema), nextCursor: z.string().nullable() }).strict(),
  },
} as const;
