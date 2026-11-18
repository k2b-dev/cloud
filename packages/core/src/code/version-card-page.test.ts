import { expect, test } from "bun:test";
import { CAPABILITY_MAX_RESULT_BYTES } from "@k2b/cloud/contracts";
import { type CodeVersionCardSnapshot, codeVersionCardsContract } from "@k2b/cloud/contracts/code-version-cards";
import { fillCodeVersionCardPage } from "./version-card-page";

const ref = (n: number) => ({ codeId: "c_info01", versionId: `66666666-6666-4666-8666-${String(n).padStart(12, "0")}` });
const snapshot: CodeVersionCardSnapshot = {
  preview: {
    ...ref(1),
    title: "Übersicht",
    ownerKind: "person",
    page: null,
    number: 1,
    running: 1,
    latest: 1,
    activated: null,
    allowed: { allowed: true },
    readiness: { state: "ready" },
  },
  review: null,
  facts: [],
  code: { state: "active", activeVersionId: ref(1).versionId, pausedAt: null, pausedBy: null },
  pages: { versionId: ref(1).versionId, homeUrl: null, pages: [] },
  latest: null,
  permission: "editor",
  canActivate: true,
  canManage: true,
};

test("UTF-8 bytes include both envelopes and all remaining refs, and page-heavy batches make progress", () => {
  const requested = Array.from({ length: 50 }, (_, n) => ref(n + 1));
  const candidates = requested.map((ref) => ({
    ...ref,
    state: "available" as const,
    snapshot: { ...snapshot, facts: ["Ü".repeat(9000)] },
  }));
  let remaining = requested;
  const settled = new Set<string>();
  let calls = 0;
  while (remaining.length) {
    const page = codeVersionCardsContract.data.parse(fillCodeVersionCardPage(remaining, candidates));
    expect(page.items.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify({ version: 1, data: { data: page } }))).toBeLessThanOrEqual(CAPABILITY_MAX_RESULT_BYTES);
    for (const item of page.items) {
      expect(settled.has(item.versionId)).toBe(false);
      settled.add(item.versionId);
    }
    remaining = page.remaining;
    calls++;
  }
  expect(calls).toBeGreaterThan(1);
  expect(settled.size).toBe(50);
});

test("a single card larger than the transport is a retryable read failure, never an endless remaining ref", () => {
  const first = ref(1),
    second = ref(2);
  const page = fillCodeVersionCardPage(
    [first, second],
    [{ ...first, state: "available", snapshot: { ...snapshot, facts: ["x".repeat(CAPABILITY_MAX_RESULT_BYTES)] } }],
  );
  expect(page).toEqual({ items: [{ ...first, state: "failed" }], remaining: [second] });
});

test("owner-budget continuation contains only requested references not yet settled", () => {
  const first = ref(1),
    second = ref(2);
  expect(fillCodeVersionCardPage([first, second], [{ ...first, state: "denied" }])).toEqual({
    items: [{ ...first, state: "denied" }],
    remaining: [second],
  });
});
