import { describe, expect, test } from "bun:test";
import type { AcquiredDraftLease } from "../../contracts";
import { classifyDraftLeaseAnswer, recoverDraftLeaseRequest } from "./mail-draft-lease-recovery";

const lease: AcquiredDraftLease = {
  token: "lease-token",
  holder: {
    kind: "user",
    id: "10000000-0000-4000-8000-000000000001",
    displayName: "Mail User",
    avatarHash: null,
  },
  acquiredAt: "2026-07-29T15:00:00.000Z",
  expiresAt: "2026-07-29T15:00:30.000Z",
};

describe("draft lease heartbeat recovery", () => {
  test("recovers automatically from transient transport failures", async () => {
    let attempts = 0;
    const result = await recoverDraftLeaseRequest({
      run: async () => (++attempts < 3 ? { kind: "unavailable" } : { kind: "ok", lease }),
      signal: new AbortController().signal,
      retryBaseMs: 0,
      retryMaxMs: 0,
      retryJitter: 0,
    });

    expect(result).toEqual({ kind: "ok", lease });
    expect(attempts).toBe(3);
  });

  test("does not retry a confirmed lease rejection", async () => {
    let attempts = 0;
    const result = await recoverDraftLeaseRequest({
      run: async () => {
        attempts++;
        return { kind: "held" };
      },
      signal: new AbortController().signal,
      retryBaseMs: 0,
      retryMaxMs: 0,
      retryJitter: 0,
    });

    expect(result).toEqual({ kind: "held" });
    expect(attempts).toBe(1);
  });

  test("stops after the bounded recovery window", async () => {
    let attempts = 0;
    const result = await recoverDraftLeaseRequest({
      run: async () => {
        attempts++;
        return { kind: "unavailable" };
      },
      signal: new AbortController().signal,
      retryBaseMs: 0,
      retryMaxMs: 0,
      retryJitter: 0,
    });

    expect(result).toEqual({ kind: "unavailable" });
    expect(attempts).toBe(3);
  });

  test("honors lifecycle cancellation between attempts", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const recovery = recoverDraftLeaseRequest({
      run: async () => {
        attempts++;
        controller.abort();
        return { kind: "unavailable" };
      },
      signal: controller.signal,
      retryBaseMs: 10,
      retryMaxMs: 10,
      retryJitter: 0,
    });

    await expect(recovery).rejects.toMatchObject({ name: "AbortError" });
    expect(attempts).toBe(1);
  });
});

describe("draft lease answer classification", () => {
  test.each([
    [200, undefined, "ok"],
    [409, "DRAFT_LEASE_HELD", "held"],
    [409, "DRAFT_LEASE_NOT_OWNED", "not-owned"],
    [409, "DRAFT_LEASE_BUSY", "unavailable"],
    [500, undefined, "unavailable"],
    [503, undefined, "unavailable"],
    [408, undefined, "unavailable"],
    [429, undefined, "unavailable"],
    [401, undefined, "unauthorized"],
    [undefined, undefined, "unavailable"],
    [400, undefined, "failed"],
    [403, undefined, "failed"],
    [404, undefined, "failed"],
    [409, "CONFLICT", "failed"],
    [409, undefined, "failed"],
    [403, "DRAFT_LEASE_HELD", "failed"],
  ] as const)("classifies status %s and code %s as %s", (status, code, expected) => {
    expect(classifyDraftLeaseAnswer(status, { code, message: "Draft open elsewhere" })).toBe(expected);
  });

  test("does not interpret messages or malformed bodies as lease codes", () => {
    for (const body of [null, "DRAFT_LEASE_HELD", { message: "Draft lease expired" }, { code: 409 }]) {
      expect(classifyDraftLeaseAnswer(409, body)).toBe("failed");
    }
  });
});
