import { lazySync } from "@valentinkolb/cloud";

export const mailScheduler = lazySync((sync) =>
  sync.scheduler({ id: "mail", delivery: { maxAttempts: 5, backoffMs: [5_000, 20_000, 60_000, 120_000] } }),
);
