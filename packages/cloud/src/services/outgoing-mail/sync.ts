import { lazySync } from "../../_internal/process-sync";

export const mailAttachments = lazySync((sync) =>
  sync.objectStore({
    id: "cloud-outgoing-mail-attachments",
    owner: "core",
    maxObjectBytes: 25 * 1024 * 1024,
    retention: { maxAgeMs: 48 * 60 * 60_000, maxBytes: 2 * 1024 * 1024 * 1024 },
  }),
);
export const mailSendJob = lazySync((sync) =>
  sync.job<{ id: string }>({
    id: "cloud-outgoing-mail-send",
    owner: "core",
    delivery: { ackWaitMs: 120_000, maxAttempts: 3, backoffMs: [5000, 30000] },
  }),
);
export const mailSettled = lazySync((sync) =>
  sync.topic<string>({
    id: "cloud-outgoing-mail-settled",
    owner: "core",
    // 256 minimal wakeups per worker in flight, following Sync's default queue budget.
    maxPayloadBytes: 1024,
    retention: { maxAgeMs: 5 * 60_000, maxBytes: 8 * 256 * 1024 },
  }),
);
export const submitMail = async (id: string): Promise<void> => {
  await mailSendJob().submit({ key: id, input: { id }, coalesce: true });
};
