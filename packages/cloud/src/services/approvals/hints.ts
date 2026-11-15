import { lazySync } from "../../_internal/process-sync";
import { logger } from "../logging";

const topic = lazySync((sync) =>
  sync.topic<null>({
    id: "cloud:approval-decisions",
    owner: "cloud",
    retention: { maxAgeMs: 120_000, maxBytes: 1_048_576 },
    maxPayloadBytes: 2000,
  }),
);
/** Best-effort wake-up after commit; readers always recheck durable state and authority. */
export const approvalDecisionHints = {
  publish(id: string): void {
    void Promise.resolve()
      .then(() => topic().publish({ tenantId: id, data: null }))
      .catch((error) => logger("approvals").warn("Decision hint failed", { error: String(error) }));
  },
  async wait(id: string, signal: AbortSignal): Promise<void> {
    for await (const _event of topic().live({ tenantId: id, signal })) return;
  },
};
