import { createHash } from "node:crypto";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import type { z } from "zod";
import type { RecordExternalUpsertInputSchema } from "./capability-contracts";
import { externalRecordRequestHash } from "./service/record-external-identity";

/** Keep durable issuance/workflow receipts addressable across the target-coordinate migration.
 * Their template/launcher already fixes the container, which the capability validates before replay.
 */
export const capabilityOperationKey = (context: Pick<CapabilityExecutionContext, "accessSubject" | "idempotencyKey">, action: string) =>
  createHash("sha256")
    .update(JSON.stringify(["grids.capability", action, context.accessSubject, context.idempotencyKey]))
    .digest("hex");

/** Preserve the durable request hash while moving the table ID from input to target. */
export const externalUpsertRequestHash = (tableId: string, input: z.infer<typeof RecordExternalUpsertInputSchema>) =>
  externalRecordRequestHash({ ...input, tableId });
