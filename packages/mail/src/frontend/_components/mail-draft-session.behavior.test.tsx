import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { isServer } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../ui/test/dom";
import type { DraftEditableContent, MailDraft, MailDraftSeed } from "../../contracts";

const MAILBOX_ID = "Box001";
const DRAFT_ID = "Drf001";
const now = "2026-10-04T10:00:00.000Z";

const content = (body: string, to: string): DraftEditableContent => ({
  senderIdentityId: "Idn001",
  to: [{ name: null, address: to }],
  cc: [],
  bcc: [],
  subject: "Offer",
  body,
  format: "markdown",
  priority: "normal",
  requestDeliveryReceipt: false,
  requestReadReceipt: false,
});

const seed: MailDraftSeed = {
  id: "10000000-0000-4000-8000-000000000001",
  mailboxId: MAILBOX_ID,
  conversationId: null,
  intent: "new",
  sourceMessageId: null,
  derivedFromMessageId: null,
  derivationKind: null,
  content: content("", "first@example.test"),
  attachments: [],
  initialSignatureSource: null,
  origin: {
    kind: "compose",
    input: {
      senderIdentityId: "Idn001",
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
  createdAt: now,
};

const draft = (revision: number, editable: DraftEditableContent): MailDraft => ({
  id: DRAFT_ID,
  mailboxId: MAILBOX_ID,
  conversationId: null,
  intent: "new",
  sourceMessageId: null,
  derivedFromMessageId: null,
  derivationKind: null,
  ...editable,
  attachments: [],
  createdBy: { kind: "user", userId: "Usr001" },
  lastEditedBy: { kind: "user", userId: "Usr001" },
  lastEditedByDisplayName: "Ada Example",
  recoveryCopyCount: 0,
  revision,
  state: "draft",
  deliveryClass: "normal",
  createdAt: now,
  updatedAt: now,
});

const lease = { holder: { kind: "user", id: "Usr001", displayName: "Ada Example", avatarHash: null }, acquiredAt: now, expiresAt: now };

describe("Mail draft session", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let dom: DomTestHarness;
  let requests: Array<{ method: string; url: string; body: unknown }>;
  let dispose = () => {};

  beforeEach(() => {
    dom = createDomTestHarness();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
    requests = [];
  });

  afterEach(() => {
    dispose();
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
    dom.cleanup();
  });

  const respondWith = (handler: (method: string, url: string, body: unknown) => Response) => {
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost"), init);
        const url = new URL(request.url).pathname;
        const text = await request.text();
        const body = text ? JSON.parse(text) : null;
        requests.push({ method: request.method, url, body });
        return handler(request.method, url, body);
      },
      { preconnect: originalFetch.preconnect },
    );
  };

  test("a send after a lost save response stores the current recipients and text before it uses the draft", async () => {
    // The first save reached the server, but its response was lost, so the browser still has no draft.
    const stored = draft(1, content("First meaningful edit", "first@example.test"));
    respondWith((method, url, body) => {
      if (url.endsWith("/draft-seeds/materialize")) return Response.json(stored);
      if (url.endsWith(`/drafts/${DRAFT_ID}/lease`) && method === "POST") return Response.json({ ...lease, token: crypto.randomUUID() });
      if (url.endsWith(`/drafts/${DRAFT_ID}`) && method === "PUT") {
        const next = body as { expectedRevision: number; draft: DraftEditableContent };
        return Response.json(draft(next.expectedRevision + 1, next.draft));
      }
      return Response.json({ code: "NOT_FOUND", message: `Unexpected ${method} ${url}` }, { status: 404 });
    });
    const { createMailDraftSession } = await import("./mail-draft-session");
    const [current, setCurrent] = createSignal(content("First meaningful edit", "first@example.test"));
    const session = createRoot((disposeRoot) => {
      dispose = disposeRoot;
      return createMailDraftSession({
        mailboxId: MAILBOX_ID,
        initialSeed: seed,
        hasVerifiedIdentity: () => true,
        content: current,
        applyDraftContent: setCurrent,
        isDisposed: () => false,
        onRecovered: () => undefined,
        onMaterialized: () => undefined,
        locale: () => "en",
      });
    });

    // Before the next autosave, the user changes the recipient and the text, then selects Send.
    setCurrent(content("Final text", "second@example.test"));
    const saved = await session.persist();

    expect(saved?.revision).toBe(2);
    expect(saved?.body).toBe("Final text");
    expect(saved?.to).toEqual([{ name: null, address: "second@example.test" }]);
    expect(requests.find((request) => request.method === "PUT")?.body).toEqual({
      expectedRevision: 1,
      draft: content("Final text", "second@example.test"),
    });
  });
});
