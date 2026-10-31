import type { RunnerConfig, RunnerLease } from "@k2b/cloud/code/runner";
import { bundleHash } from "../src/cache";

export const config: RunnerConfig = {
  slots: 2,
  pollMs: 100,
  retryMs: 5,
  transportMs: 3000,
  bundleBytes: 64 * 1024,
  cacheBytes: 128 * 1024,
  bridgeBytes: 64 * 1024,
  processMemoryBytes: 128 * 1024 * 1024,
};
export const source = 'export async function main(input, cloud) { await cloud.call("echo", input); }';
export const lease = (overrides: Partial<RunnerLease> = {}): RunnerLease => ({
  runId: "run-a",
  codeId: "code-a",
  versionId: "version-a",
  organizationId: "org-a",
  trustTier: "approved",
  entrypoint: "main",
  generation: 1,
  mandateRevision: 1,
  bundleHash: bundleHash(source),
  token: "opaque-run-token",
  input: { hello: "world" },
  deadlineAt: Date.UTC(2030, 0, 2) + 5000,
  leaseExpiresAt: Date.UTC(2030, 0, 2) + 5000,
  heartbeatMs: 100,
  ...overrides,
});
