import { invokeCapability } from "@k2b/cloud/capabilities/server";

type MandateJob = { id: string; draftId: string; mandateId: string; mandateRevision: number };

/** Background mandate call from identity/background-mandates.md; the platform signs at send time. */
export const sendDraftUnderMandate = async (job: MandateJob) => {
  return invokeCapability(
    {
      appId: "mail",
      capabilityId: "message.send",
      kind: "action",
      input: { draftId: job.draftId },
      idempotencyKey: job.id,
    },
    {
      mandate: {
        id: job.mandateId,
        revision: job.mandateRevision,
        callingAppId: "inventory",
      },
    },
  );
};
