import { addressBudgetKey } from "./address";

/** Strict fixed window: at most the approved 300 transfer starts per source network in 600 seconds. */
export class IpBudget {
  private readonly peers = new Map<string, { start: number; count: number; active: number }>();
  private active = 0;
  private nextSweep = 0;
  private earliestExpiry = Number.POSITIVE_INFINITY;
  constructor(private readonly options: { maxPeers: number; maxActive: number; now?: () => number }) {}
  acquire(ip: string, transfer: boolean): { release: () => void } | { status: 429 | 503; retryAfter: number } {
    const now = this.options.now?.() ?? performance.now();
    const key = addressBudgetKey(ip);
    let peer = this.peers.get(key);
    if (!peer) {
      // New sources cannot force a ledger scan per packet. Reclaim at most once per second.
      if (now >= this.nextSweep) {
        this.earliestExpiry = Number.POSITIVE_INFINITY;
        for (const [existing, value] of this.peers) {
          if (value.active === 0 && now - value.start >= 600_000) this.peers.delete(existing);
          else this.earliestExpiry = Math.min(this.earliestExpiry, value.start + 600_000);
        }
        this.nextSweep = now + 1_000;
      }
      if (this.peers.size >= this.options.maxPeers)
        return { status: 503, retryAfter: Math.max(1, Math.ceil((this.earliestExpiry - now) / 1_000)) };
      peer = { start: now, count: 0, active: 0 };
      this.peers.set(key, peer);
      this.earliestExpiry = Math.min(this.earliestExpiry, now + 600_000);
    }
    if (now - peer.start >= 600_000) {
      peer.start = now;
      peer.count = 0;
    }
    if (transfer && peer.count >= 300) return { status: 429, retryAfter: Math.max(1, Math.ceil((peer.start + 600_000 - now) / 1_000)) };
    // Two adjacent five-request phases can overlap while abort propagates through an ingress.
    if (peer.active >= 10) return { status: 429, retryAfter: 1 };
    if (this.active >= this.options.maxActive) return { status: 503, retryAfter: 1 };
    if (transfer) peer.count++;
    peer.active++;
    this.active++;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        peer.active--;
        this.active--;
        if (peer.active === 0 && (this.options.now?.() ?? performance.now()) - peer.start >= 600_000) this.peers.delete(key);
      },
    };
  }
}
