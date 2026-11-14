import { addressBudgetKey } from "./address";
import { type Mode, PLANS } from "./engine";

export interface CapacityOptions {
  maxPeers: number;
  maxActive: number;
  capacityMbps?: number;
  testMbps?: number;
  now?: () => number;
}
type Refusal = { status: 429 | 503; retryAfter: number };
interface Session {
  key: string;
  expires: number;
  active: number;
  limited: boolean;
  controller: AbortController;
}

/** A start is a whole test, never one of its four streams. No persistent visitor identity. */
export class TestAdmission {
  private readonly peers = new Map<string, number[]>();
  private readonly networks = new Map<string, number[]>();
  private readonly sessions = new Map<string, Session>();
  private nextSweep = 0;
  private tokens: number;
  private updated: number;
  readonly capacityMbps: number;
  readonly testMbps: number;
  readonly maxTests: number;
  private readonly bytesPerSecond: number;
  constructor(private readonly options: CapacityOptions) {
    this.capacityMbps = options.capacityMbps ?? 1_000;
    this.testMbps = options.testMbps ?? this.capacityMbps;
    this.maxTests = Math.min(Math.floor(this.capacityMbps / this.testMbps), Math.floor(options.maxActive / 10));
    if (
      !Number.isFinite(this.capacityMbps) ||
      !Number.isFinite(this.testMbps) ||
      this.capacityMbps < 1 ||
      this.testMbps < 1 ||
      this.maxTests < 1
    )
      throw new Error("Speedtest capacity must admit at least one test with ten stream slots");
    this.bytesPerSecond = (this.capacityMbps * 1_000_000) / 8;
    this.tokens = this.bytesPerSecond;
    this.updated = this.now();
  }
  private now() {
    return this.options.now?.() ?? performance.now();
  }
  private sweep(now: number) {
    for (const [token, session] of this.sessions) {
      if (session.expires <= now) {
        session.controller.abort();
        this.sessions.delete(token);
      }
    }
    if (now < this.nextSweep) return;
    this.nextSweep = now + 1_000;
    for (const ledger of [this.peers, this.networks])
      for (const [key, starts] of ledger) if (starts.every((start) => now - start >= 60_000)) ledger.delete(key);
  }
  start(ip: string, mode: Mode): { token: string; expiresIn: number; capacityMbps: number } | Refusal {
    const now = this.now();
    this.sweep(now);
    const key = addressBudgetKey(ip);
    const starts = (this.peers.get(key) ?? []).filter((start) => now - start < 60_000);
    if (starts.length >= 2) return { status: 429, retryAfter: Math.max(1, Math.ceil((starts[0]! + 60_000 - now) / 1_000)) };
    const network = key.endsWith("/64") ? `${key.split(":").slice(0, 3).join(":")}::/48` : undefined;
    const networkStarts = network ? (this.networks.get(network) ?? []).filter((start) => now - start < 60_000) : [];
    // Sixteen /64 connections can each use two starts per minute within one /48.
    if (networkStarts.length >= 32) return { status: 429, retryAfter: Math.max(1, Math.ceil((networkStarts[0]! + 60_000 - now) / 1_000)) };
    if (this.sessions.size >= this.maxTests) {
      const expiry = Math.min(...Array.from(this.sessions.values(), (session) => session.expires));
      return { status: 503, retryAfter: Math.max(1, Math.ceil((expiry - now) / 1_000)) };
    }
    if (!this.peers.has(key) && this.peers.size >= this.options.maxPeers) return { status: 503, retryAfter: 1 };
    if (network && !this.networks.has(network) && this.networks.size >= this.options.maxPeers) return { status: 503, retryAfter: 1 };
    const plan = PLANS[mode];
    const expiresIn = plan.ping + plan.download + plan.upload;
    const token = crypto.randomUUID();
    this.peers.set(key, [...starts, now]);
    if (network) this.networks.set(network, [...networkStarts, now]);
    this.sessions.set(token, { key, expires: now + expiresIn, active: 0, limited: false, controller: new AbortController() });
    return { token, expiresIn, capacityMbps: this.capacityMbps };
  }
  private session(ip: string, token: string | null): Session | undefined {
    this.sweep(this.now());
    if (!token || token.length > 64) return;
    const session = this.sessions.get(token);
    return session?.key === addressBudgetKey(ip) ? session : undefined;
  }
  status(ip: string, token: string | null) {
    const session = this.session(ip, token);
    return session ? { limited: session.limited } : undefined;
  }
  end(ip: string, token: string | null): boolean {
    const session = this.session(ip, token);
    if (!session || !token) return false;
    session.controller.abort();
    this.sessions.delete(token);
    return true;
  }
  acquire(
    ip: string,
    token: string | null,
  ):
    | { signal: AbortSignal; remaining: number; consume: (bytes: number) => boolean; release: () => void }
    | Refusal
    | { status: 401; retryAfter: number } {
    const session = this.session(ip, token);
    if (!session) return { status: 401, retryAfter: 0 };
    if (session.limited) return { status: 503, retryAfter: 1 };
    // Two adjacent five-request phases may overlap while cancellation reaches the server.
    if (session.active >= 10) return { status: 429, retryAfter: 1 };
    session.active++;
    let released = false;
    return {
      signal: session.controller.signal,
      remaining: Math.max(0, session.expires - this.now()),
      consume: (bytes) => {
        const now = this.now();
        this.tokens = Math.min(this.bytesPerSecond, this.tokens + (Math.max(0, now - this.updated) * this.bytesPerSecond) / 1_000);
        this.updated = now;
        if (session.limited || bytes > this.tokens) {
          session.limited = true;
          return false;
        }
        this.tokens -= bytes;
        return true;
      },
      release: () => {
        if (!released) {
          released = true;
          session.active--;
        }
      },
    };
  }
}
