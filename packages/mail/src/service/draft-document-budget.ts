import { MAX_DRAFT_DOCUMENT_PAYLOAD } from "../draft-document-contracts";

const MiB = 1024 ** 2;
/**
 * Admission budget for a 1 GiB Mail process, leaving 768 MiB for SQL/Yjs,
 * application code, native clients and GC. The remaining 256 MiB allows
 * 64 MiB each for ingress, deliveries and native WebSocket buffers, plus
 * 32 MiB of connection bookkeeping (512 × 64 KiB) and 32 MiB headroom.
 * These are buffer/admission ceilings, not a total RSS guarantee: benchmark
 * the process with its other workloads before enabling shared editing.
 */
export const DRAFT_SOCKET_LIMITS = {
  connections: 512,
  // One cursor fanout stays within a 2 MiB transient batch (8 × 256 KB).
  peers: 8,
  ingressBytes: 64 * MiB,
  deliveryBytes: 64 * MiB,
  outboundBytes: 64 * MiB,
  connectionBytes: 2 * (MAX_DRAFT_DOCUMENT_PAYLOAD + 1000),
} as const;

type BufferKind = "ingress" | "delivery" | "outbound";

/** Process-local admission only; replicas independently enforce the same budget. */
export class DraftDocumentBudget {
  private readonly drafts = new Map<string, number>();
  private connections = 0;
  private readonly bytes = { ingress: 0, delivery: 0, outbound: 0 };
  private rejected = 0;
  private readonly closes = { 1008: 0, 1009: 0, 1012: 0, 1013: 0 };

  acquire(draftId: string): (() => boolean) | null {
    const peers = this.drafts.get(draftId) ?? 0;
    if (this.connections >= DRAFT_SOCKET_LIMITS.connections || peers >= DRAFT_SOCKET_LIMITS.peers) {
      this.rejected++;
      return null;
    }
    this.connections++;
    this.drafts.set(draftId, peers + 1);
    let released = false;
    return () => {
      if (released) return false;
      released = true;
      this.connections--;
      const remaining = (this.drafts.get(draftId) ?? 1) - 1;
      if (remaining) this.drafts.set(draftId, remaining);
      else this.drafts.delete(draftId);
      return remaining === 0;
    };
  }

  claim(kind: BufferKind, bytes: number): boolean {
    const limit = DRAFT_SOCKET_LIMITS[`${kind}Bytes`];
    if (this.bytes[kind] + bytes > limit) {
      this.rejected++;
      return false;
    }
    this.bytes[kind] += bytes;
    return true;
  }

  release(kind: BufferKind, bytes: number): void {
    this.bytes[kind] -= bytes;
  }
  recordClose(code: keyof typeof this.closes): void {
    this.closes[code]++;
  }
  snapshot() {
    return {
      connections: this.connections,
      documents: this.drafts.size,
      ...this.bytes,
      rejected: this.rejected,
      closes: { ...this.closes },
    };
  }
}
export const draftDocumentBudget = new DraftDocumentBudget();
