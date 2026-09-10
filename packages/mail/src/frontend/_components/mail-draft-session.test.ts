import { describe, expect, test } from "bun:test";
import type { MailDraftSeed } from "../../contracts";
import {
  createSerializedDraftMutationQueue,
  draftSeedContentChanged,
  isDraftLeaseHeldResponse,
  reconcileDraftSessionAfterLiveInvalidation,
} from "./mail-draft-session";

const seed: MailDraftSeed = {
  id: "10000000-0000-4000-8000-000000000001",
  mailboxId: "20000000-0000-4000-8000-000000000002",
  conversationId: null,
  intent: "new",
  sourceMessageId: null,
  derivedFromMessageId: null,
  derivationKind: null,
  content: {
    senderIdentityId: "30000000-0000-4000-8000-000000000003",
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    body: "Best regards,\nCloud Team",
    format: "markdown",
    priority: "normal",
    requestDeliveryReceipt: false,
    requestReadReceipt: false,
  },
  attachments: [],
  initialSignatureSource: "Best regards,\nCloud Team",
  origin: {
    kind: "compose",
    input: {
      senderIdentityId: "30000000-0000-4000-8000-000000000003",
      to: [],
      cc: [],
      bcc: [],
      subject: "",
      body: "",
      intent: "new",
      conversationId: null,
      sourceMessageId: null,
      includeSourceAttachments: false,
    },
  },
  createdAt: "2026-07-28T12:00:00.000Z",
};

describe("createSerializedDraftMutationQueue", () => {
  test("serializes operations and continues after a rejection", async () => {
    const serialize = createSerializedDraftMutationQueue();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = serialize(async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
      throw new Error("expected");
    });
    const second = serialize(async () => {
      events.push("second");
      return 2;
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst?.();
    await expect(first).rejects.toThrow("expected");
    expect(await second).toBe(2);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });
});

describe("draft seed changes", () => {
  test("does not treat the prepared signature-only baseline as a user edit", () => {
    expect(draftSeedContentChanged(seed, seed.content)).toBe(false);
  });

  test("detects meaningful body and recipient changes", () => {
    expect(
      draftSeedContentChanged(seed, {
        ...seed.content,
        body: `Hello\n\n${seed.content.body}`,
      }),
    ).toBe(true);
    expect(
      draftSeedContentChanged(seed, {
        ...seed.content,
        to: [{ name: "Recipient", address: "recipient@example.com" }],
      }),
    ).toBe(true);
  });

  test("returns to clean when an edit is reverted to the exact baseline", () => {
    const edited = { ...seed.content, subject: "Temporary" };
    expect(draftSeedContentChanged(seed, edited)).toBe(true);
    expect(
      draftSeedContentChanged(seed, {
        ...edited,
        subject: seed.content.subject,
      }),
    ).toBe(false);
  });
});

describe("live draft reconciliation", () => {
  test("checks the active lease immediately after refreshing an editable draft", async () => {
    const calls: string[] = [];
    await reconcileDraftSessionAfterLiveInvalidation({
      refreshLifecycle: async () => void calls.push("lifecycle"),
      hasLifecycleTransition: () => false,
      resumeLease: async () => void calls.push("lease"),
    });
    expect(calls).toEqual(["lifecycle", "lease"]);
  });

  test("does not reacquire a lease after the draft was sent or discarded", async () => {
    const calls: string[] = [];
    await reconcileDraftSessionAfterLiveInvalidation({
      refreshLifecycle: async () => void calls.push("lifecycle"),
      hasLifecycleTransition: () => true,
      resumeLease: async () => void calls.push("lease"),
    });
    expect(calls).toEqual(["lifecycle"]);
  });
});

describe("draft lease rejection", () => {
  test("recognizes only the exclusive-lease conflict raised by the API", async () => {
    expect(await isDraftLeaseHeldResponse(Response.json({ code: "DRAFT_LEASE_HELD", message: "held" }, { status: 409 }))).toBe(true);
    expect(await isDraftLeaseHeldResponse(Response.json({ code: "CONFLICT", message: "revision" }, { status: 409 }))).toBe(false);
    expect(await isDraftLeaseHeldResponse(new Response("gateway", { status: 502 }))).toBe(false);
    expect(await isDraftLeaseHeldResponse(new Response("not json", { status: 409 }))).toBe(false);
  });
});
