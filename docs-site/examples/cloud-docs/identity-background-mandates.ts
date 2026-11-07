import { invokeCapability } from "@k2b/cloud/capabilities/server";
import { getAppWorkloadCredential } from "@k2b/cloud/services";

type MandateJob = { id: string; draftId: string; mandateId: string; mandateRevision: number };

/** Background mandate call from identity/background-mandates.md; read the credential at call time. */
export const sendDraftUnderMandate = async (job: MandateJob) => {
  const credential = getAppWorkloadCredential();
  if (!credential) throw new Error("App workload authorization is unavailable");

  return invokeCapability(
    {
      appId: "mail",
      capabilityId: "message.send",
      kind: "action",
      input: { draftId: job.draftId },
      idempotencyKey: job.id,
    },
    {
      authorization: `Bearer ${credential}`,
      mandate: {
        id: job.mandateId,
        revision: job.mandateRevision,
        callingAppId: "inventory",
      },
    },
  );
};
