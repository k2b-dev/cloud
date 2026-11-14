/** Recent acknowledged byte throughput, excluding bytes already present in a resumed session. */
export function createUploadEstimate() {
  let rate = 0;
  let transferred = 0;
  let sampledBytes = 0;
  let started: number | null = null;
  let sampled = 0;
  let rowBytes: number | null = null;
  return {
    start(now: number) {
      rowBytes = null;
      if (started === null) started = sampled = now;
    },
    progress(sent: number, remaining: number, now: number): number | null {
      // The SDK reports existing receipts before it transfers bytes. Count only subsequent increases.
      if (rowBytes !== null) transferred += Math.max(0, sent - rowBytes);
      rowBytes = sent;
      const elapsed = (now - sampled) / 1000;
      const delta = transferred - sampledBytes;
      if (elapsed >= 1 && delta > 0) {
        const current = delta / elapsed;
        // A 30-second time constant damps one slow segment but follows sustained connection changes.
        rate = rate ? rate + (1 - Math.exp(-elapsed / 30)) * (current - rate) : current;
        sampledBytes = transferred;
        sampled = now;
      }
      if (!rate || started === null || now - started < 3000 || remaining <= 0) return null;
      return Math.ceil(remaining / rate);
    },
    reset() {
      rate = transferred = sampledBytes = sampled = 0;
      started = rowBytes = null;
    },
  };
}
