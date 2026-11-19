import { withNetworkDeadline } from "@k2b/cloud/services/network-transport";
import { type JmapDetection, probeJmap } from "./jmap-client";

/** Unknown preserves an existing observation only while the IMAP host is unchanged. */
export function storedJmapDetection(detection: JmapDetection, previous: boolean | null = null, hostChanged = false): boolean | null {
  return detection === "detected" ? true : detection === "absent" ? false : hostChanged ? null : previous;
}

/** Explicit connection actions only; background connector verification must never probe. */
export async function withJmapDetection<T>(
  host: string,
  operation: () => Promise<T>,
  options: { waitForProbe?: boolean; probe?: typeof probeJmap } = {},
): Promise<{ result: T; jmap: JmapDetection }> {
  const controller = new AbortController();
  let jmap: JmapDetection = "unknown";
  // Same 5-second discovery deadline as onboarding-discovery.ts.
  const detection = withNetworkDeadline(5_000, controller.signal, new Error("Discovery timed out"), async (signal) => {
    const detected = await (options.probe ?? probeJmap)(host, signal);
    if (!signal.aborted) jmap = detected;
  }).catch(() => {});
  try {
    const result = await operation();
    // Explicit limit refresh waits for discovery; create/replace must not delay verification.
    if (!options.waitForProbe) controller.abort();
    await detection;
    return { result, jmap };
  } finally {
    controller.abort();
  }
}
