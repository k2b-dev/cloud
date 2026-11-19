import { z } from "zod";
import type { MailDraft } from "./contracts";

export const draftQuarantineRecoverySchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    generation: z.string().regex(/^[1-9]\d*$/),
    requestId: z.string().uuid(),
  })
  .strict();

export type DraftQuarantineRecoveryInput = z.infer<typeof draftQuarantineRecoverySchema>;
export type DraftQuarantineInspection = {
  revision: number;
  generation: string;
  historyComplete: boolean;
  snapshotCursor: string | null;
  idleThrough: string | null;
  seedCursor: string | null;
  firstRetainedSequence: number;
  head: string;
  /** Eligibility is checked again under admission and coverage locks on recovery. */
  originalRepairPossible: boolean;
};
export type DraftQuarantineRecovery = {
  outcome: "original_repaired" | "recovery_copy";
  draft: MailDraft;
  reviewRequired: boolean;
};
