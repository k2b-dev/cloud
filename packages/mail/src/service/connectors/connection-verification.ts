import { withNetworkDeadline } from "@k2b/cloud/services/network-transport";
import { probeJmap } from "./jmap-client";

/** Adds a credential-free hint to verification or limit discovery without extending either operation. */
export async function withJmapDetection<T>(
  host: string,
  operation: () => Promise<T>,
  probe: typeof probeJmap = probeJmap,
  callerSignal?: AbortSignal,
): Promise<{ result: T; jmap: boolean }> {
  const controller = new AbortController();
  let jmap = false;
  // Same discovery deadline as onboarding-discovery.ts. A finished provider check cancels it sooner.
  const detection = withNetworkDeadline(
    5_000,
    callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal,
    new Error("Discovery timed out"),
    async (signal) => {
      const detected = await probe(host, signal);
      if (!signal.aborted) jmap = detected;
    },
  ).catch(() => {});
  try {
    const result = await operation();
    controller.abort();
    await detection;
    return { result, jmap };
  } finally {
    controller.abort();
  }
}
