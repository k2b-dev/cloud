import { describe, expect, test } from "bun:test";
import { DRAFT_SOCKET_LIMITS, DraftDocumentBudget } from "./draft-document-budget";

describe("Mail document process budget", () => {
  test("caps peers and process connections, retaining capacity until cleanup releases it", () => {
    const budget = new DraftDocumentBudget();
    const leases: Array<() => boolean> = [];
    for (let i = 0; i < DRAFT_SOCKET_LIMITS.connections; i++) {
      const lease = budget.acquire(`draft-${Math.floor(i / DRAFT_SOCKET_LIMITS.peers)}`);
      expect(lease).not.toBeNull();
      if (lease) leases.push(lease);
    }
    expect(budget.acquire("another-draft")).toBeNull();
    expect(budget.acquire("draft-0")).toBeNull();
    expect(leases[0]!()).toBe(false);
    expect(leases[0]!()).toBe(false);
    expect(budget.acquire("draft-0")).not.toBeNull();
    expect(budget.snapshot().connections).toBe(DRAFT_SOCKET_LIMITS.connections);
    // A separate instance proves last-peer detection independently of process capacity.
    const alone = new DraftDocumentBudget();
    const release = alone.acquire("draft");
    expect(release?.()).toBe(true);
    expect(release?.()).toBe(false);
    expect(alone.snapshot()).toMatchObject({ connections: 0, documents: 0 });
  });

  for (const kind of ["ingress", "delivery", "outbound"] as const) {
    test(`${kind} rejects one byte over its process budget and recovers after release`, () => {
      const budget = new DraftDocumentBudget();
      const bytes = DRAFT_SOCKET_LIMITS[`${kind}Bytes`];
      expect(budget.claim(kind, bytes)).toBe(true);
      expect(budget.claim(kind, 1)).toBe(false);
      expect(budget.snapshot()[kind]).toBe(bytes);
      budget.release(kind, bytes);
      expect(budget.claim(kind, 1)).toBe(true);
      budget.release(kind, 1);
      expect(budget.snapshot()[kind]).toBe(0);
    });
  }
});
