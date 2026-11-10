import { afterEach, beforeEach, describe, expect, jest, setSystemTime, spyOn, test } from "bun:test";
import { setImmediate } from "node:timers";
import { EditorView } from "@codemirror/view";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { contactDirectory, defineCapabilities } from "@k2b/cloud/contracts";
import { crypto as cryptoUtils, encoding } from "@k2b/stdlib";
import { delegateEvents, isServer, render } from "solid-js/web";
import * as Y from "yjs";
import { z } from "zod";
import { createDomTestHarness, type DomTestHarness } from "../../../../ui/test/dom";
import {
  composePreviewInputSchema,
  type DraftEditableContent,
  draftEditableContentInputSchema,
  MAX_DRAFT_ATTACHMENT_BYTES,
  type MailDraft,
  type MailDraftSeed,
  materializeDraftSeedInputSchema,
  type SenderIdentity,
} from "../../contracts";
import { createDraftDocument, DRAFT_BODY, readDraftDocument, writeLocalDraftHeaders } from "../../lib/draft-document";

const now = "2026-10-11T10:00:00.000Z";
const identity = (id: string, label: string, signature: string): SenderIdentity => ({
  id,
  mailboxId: "Box001",
  label,
  displayName: label,
  fromAddress: `${label.toLowerCase()}@example.test`,
  replyTo: null,
  defaultCc: [],
  defaultBcc: [],
  defaultFormat: "markdown",
  defaultPriority: "normal",
  defaultDeliveryReceipt: false,
  defaultReadReceipt: false,
  vcard: null,
  envelopeSender: null,
  defaultSignatureTemplateId: signature,
  transport: {
    mode: "mailbox",
    host: null,
    port: null,
    tlsMode: null,
    username: null,
    secret: { kind: null, isSet: false },
    revision: 0,
    status: "active",
    capabilities: { dsn: false, size: false, maxMessageBytes: null },
    lastVerifiedAt: null,
    lastError: null,
  },
  authenticationPolicy: { automation: "mailbox" },
  sentFolderId: null,
  draftsFolderId: null,
  isDefault: id === "Send01",
  status: "verified",
  statusReason: null,
  pendingVerificationCommandId: null,
  createdAt: now,
  updatedAt: now,
});
const initialDraft: MailDraft = {
  id: "Draft1",
  mailboxId: "Box001",
  conversationId: null,
  intent: "new",
  sourceMessageId: null,
  derivedFromMessageId: null,
  derivationKind: null,
  quoteSource: null,
  senderIdentityId: "Send01",
  signatureTemplateId: "Sign02",
  to: [{ name: null, address: "recipient@example.test" }],
  cc: [],
  bcc: [],
  subject: "Offer",
  body: "Hello",
  format: "markdown",
  priority: "normal",
  requestDeliveryReceipt: false,
  requestReadReceipt: false,
  attachments: [],
  suggestion: false,
  suggestedBy: null,
  createdBy: { kind: "user", userId: "Usr001" },
  lastEditedBy: { kind: "user", userId: "Usr001" },
  lastEditedByDisplayName: "Ada",
  recoveryCopyCount: 0,
  revision: 1,
  state: "draft",
  deliveryClass: "normal",
  createdAt: now,
  updatedAt: now,
};

const initialSeed: MailDraftSeed = {
  id: "10000000-0000-4000-8000-000000000001",
  mailboxId: "Box001",
  conversationId: null,
  intent: "new",
  sourceMessageId: null,
  derivedFromMessageId: null,
  derivationKind: null,
  content: draftEditableContentInputSchema.strip().parse(initialDraft),
  attachments: [],
  origin: {
    kind: "compose",
    input: {
      quoteSource: null,
      senderIdentityId: "Send01",
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

// Sockets stay offline unless a test explicitly opens one.
class OfflineWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: OfflineWebSocket[] = [];
  readyState = OfflineWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(readonly url?: string) {
    OfflineWebSocket.instances.push(this);
  }
  open() {
    this.readyState = OfflineWebSocket.OPEN;
    this.onopen?.();
  }
  message(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  onclose = null;
  onerror = null;
  send(_data: string) {}
  close() {
    this.readyState = OfflineWebSocket.CLOSED;
  }
}

const installPopover = () => {
  const open = new WeakSet<HTMLElement>();
  const matches = HTMLElement.prototype.matches;
  Object.defineProperty(HTMLElement.prototype, "matches", {
    configurable: true,
    value(this: HTMLElement, selector: string) {
      return selector === ":popover-open" ? open.has(this) : matches.call(this, selector);
    },
  });
  HTMLElement.prototype.showPopover = function () {
    open.add(this);
  };
  HTMLElement.prototype.hidePopover = function () {
    open.delete(this);
  };
};

const waitFor = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 150 && !condition(); attempt++) await Bun.sleep(10);
  expect(condition()).toBe(true);
};

describe("MailComposer signature choice", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  let dom: DomTestHarness;
  let dispose = () => {};
  let saves: DraftEditableContent[];
  let previews: DraftEditableContent[];

  beforeEach(() => {
    dom = createDomTestHarness();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: OfflineWebSocket });
    installPopover();
    delegateEvents(["click"]);
    OfflineWebSocket.instances = [];
    saves = [];
    previews = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost"), init);
        const path = new URL(request.url).pathname;
        if (path.endsWith("/lease"))
          return Response.json({
            token: crypto.randomUUID(),
            holder: { kind: "user", id: "Usr001", displayName: "Ada", avatarHash: null },
            acquiredAt: now,
            expiresAt: now,
          });
        if (path.endsWith("/compose-preview")) {
          const json = composePreviewInputSchema.parse(await request.json());
          previews.push(json.draft);
          return Response.json({ html: "<p>Hello</p>", text: "Hello", formattingWarnings: [] });
        }
        if (path.endsWith("/draft-seeds/materialize")) {
          const json = materializeDraftSeedInputSchema.parse(await request.json());
          saves.push(json.draft);
          return Response.json({ ...initialDraft, ...json.draft });
        }
        if (path.endsWith("/drafts/Draft1") && request.method === "GET") return Response.json(initialDraft);
        if (path.endsWith("/drafts/Draft1") && request.method === "PUT") {
          const json = z
            .object({ expectedRevision: z.number().int().positive(), draft: draftEditableContentInputSchema })
            .parse(await request.json());
          saves.push(json.draft);
          return Response.json({ ...initialDraft, ...json.draft, revision: json.expectedRevision + 1 });
        }
        throw new Error(`Unexpected request: ${request.method} ${path}`);
      },
      { preconnect: originalFetch.preconnect },
    );
  });
  afterEach(async () => {
    // A disposed composer still saves the typing it held before it releases its lease. Let that finish against this
    // test's server, so it never reaches the next test's.
    const testFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = Object.assign((...args: Parameters<typeof fetch>) => (calls++, testFetch(...args)), {
      preconnect: originalFetch.preconnect,
    });
    dispose();
    const end = performance.now() + 1_000;
    for (let quiet = 0, seen = calls; quiet < 3 && performance.now() < end; ) {
      await Bun.sleep(5);
      quiet = calls === seen ? quiet + 1 : 0;
      seen = calls;
    }
    globalThis.fetch = originalFetch;
    for (const [key, descriptor] of [
      ["localStorage", originalStorage],
      ["WebSocket", originalWebSocket],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.cleanup();
  });

  const mount = async (
    locale: "en" | "de" = "en",
    draft = initialDraft,
    templates = [
      { id: "Sign01", name: "Support signature" },
      { id: "Sign02", name: "Personal signature" },
      { id: "Sign03", name: "Sales signature" },
    ],
    seed?: MailDraftSeed,
    settle?: () => Promise<void>,
  ) => {
    const [{ default: MailComposer }, { LocaleProvider }] = await Promise.all([import("./MailComposer"), import("@k2b/ui")]);
    dispose = render(
      () => (
        <LocaleProvider locale={locale}>
          <MailComposer
            mailboxId="Box001"
            currentActor={{ kind: "user", id: "Usr001" }}
            identities={[identity("Send01", "Support", "Sign01"), identity("Send02", "Sales", "Sign01")]}
            signatures={{ templates, personalDefaults: [{ senderIdentityId: "Send02", templateId: "Sign03" }] }}
            initialDraft={seed ? undefined : draft}
            initialSeed={seed}
            initialPanes={{ version: 2, root: { type: "group", items: ["editor", "preview"], active: settle ? "editor" : "preview" } }}
            returnHref="/app/mail/Box001"
            dateConfig={{ locale, timeZone: "UTC" }}
          />
        </LocaleProvider>
      ),
      dom.root,
    );
    if (settle) {
      await settle();
      for (let attempt = 0; attempt < 100 && !dom.root.querySelector(".cm-content"); attempt++) await settle();
    } else await waitFor(() => Boolean(dom.root.querySelector<HTMLButtonElement>("footer button.mail-compose-action:not(:disabled)")));
  };
  const trigger = () => dom.root.querySelector<HTMLButtonElement>("footer button.mail-composer-signature")!;
  const choose = (label: string, role: "menuitemradio" | "menuitem" = "menuitemradio") => {
    const option = Array.from(dom.document.querySelectorAll<HTMLElement>(`[role="${role}"]`)).find((item) =>
      item.textContent?.includes(label),
    );
    expect(option).toBeDefined();
    option!.click();
  };

  test("the page composer distinguishes device storage from confirmed server storage during autosave", async () => {
    delegateEvents(["click", "input"]);
    await mount();
    expect(dom.root.querySelector("[data-mail-save-status]")?.textContent).toContain("Saved on server");
    const subject = dom.root.querySelector<HTMLInputElement>('input[aria-label="Subject"]')!;
    subject.value = "Changed before autosave";
    subject.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => dom.root.querySelector("[data-mail-save-status]")?.getAttribute("data-mail-save-status") === "local");
    expect(dom.root.querySelector("[data-mail-save-status]")?.textContent).toContain("Saved on this device");
    await waitFor(() => dom.root.querySelector("[data-mail-save-status]")?.getAttribute("data-mail-save-status") === "saved");
    expect(saves.at(-1)?.subject).toBe("Changed before autosave");
  });

  test("shared projection preserves an open empty Cc and its unfinished query without republishing remote input", async () => {
    const offline = await import("@k2b/cloud/browser/shared-text");
    const generations = spyOn(offline, "listSharedTextOfflineGenerations").mockResolvedValue([]);
    const base = draftEditableContentInputSchema.strip().parse(initialDraft);
    const document = createDraftDocument(base);
    const bytes = Y.encodeStateAsUpdate(document);
    const cursor = "s6t.fixture.1";
    const requests: string[] = [];
    const fetchWithFixtures = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost"), init);
        const path = new URL(request.url).pathname;
        requests.push(path);
        if (path.endsWith("/document"))
          return Response.json({
            generation: "1",
            revision: 1,
            lifecycle: "draft",
            historyComplete: true,
            fresh: { state: encoding.toBase64(bytes), cursor, content: base },
            durable: { state: encoding.toBase64(bytes), cursor, content: base },
            frozen: null,
          });
        return fetchWithFixtures(request);
      },
      { preconnect: originalFetch.preconnect },
    );
    localStorage.setItem("cloud:mail:shared:Usr001:Draft1:1:remember", "no");
    const settle = async () => {
      await Bun.sleep(0);
      const socket = OfflineWebSocket.instances.find((socket) => socket.url && new URL(socket.url).pathname.endsWith("/document/socket"));
      if (socket?.readyState === 0) {
        socket.open();
        socket.message({ type: "replayReady", payload: { docId: "Draft1", generation: "1", cursor, peerId: "peer1" } });
      }
    };
    try {
      delegateEvents(["click", "input"]);
      await mount("en", { ...initialDraft, editMode: "shared", generation: "1" }, undefined, undefined, settle);
      await waitFor(() => Boolean(dom.root.querySelector<HTMLButtonElement>("footer button.mail-compose-action:not(:disabled)")));
      Array.from(dom.root.querySelectorAll("button"))
        .find((button) => button.textContent === "Cc/Bcc")!
        .click();
      const cc = dom.root.querySelector<HTMLInputElement>('input[aria-label="Cc recipients"]')!;
      expect(cc).not.toBeNull();
      cc.value = "unfinished recipient";
      cc.dispatchEvent(new Event("input", { bubbles: true }));
      const socket = OfflineWebSocket.instances.find((socket) => socket.url && new URL(socket.url).pathname.endsWith("/document/socket"))!;
      const send = spyOn(socket, "send");
      const vector = Y.encodeStateVector(document);
      writeLocalDraftHeaders(document, base, { ...base, subject: "Peer subject" });
      document.getText(DRAFT_BODY).insert(document.getText(DRAFT_BODY).length, " peer");
      socket.message({
        type: "syncPush",
        payload: {
          docId: "Draft1",
          generation: "1",
          updates: [{ generation: "1", payload: encoding.toBase64(Y.encodeStateAsUpdate(document, vector)), cursor }],
        },
      });
      await waitFor(() => dom.root.querySelector<HTMLInputElement>('input[aria-label="Subject"]')?.value === "Peer subject");
      expect(dom.root.querySelector('input[aria-label="Cc recipients"]')).toBe(cc);
      expect(cc.value).toBe("unfinished recipient");
      expect(readDraftDocument(document).body).toContain(" peer");
      expect(send.mock.calls.filter(([raw]) => JSON.parse(raw).type === "syncPublish")).toHaveLength(0);
      const view = EditorView.findFromDOM(dom.root.querySelector<HTMLElement>(".cm-editor")!)!;
      expect(view.state.doc.toString()).toBe("Hello peer");
      view.dispatch({ changes: { from: view.state.doc.length, insert: " local" }, userEvent: "input.type" });
      const publications = send.mock.calls.map(([raw]) => JSON.parse(raw)).filter((packet) => packet.type === "syncPublish");
      expect(publications).toHaveLength(1);
      Y.applyUpdate(document, encoding.fromBase64(publications[0].payload.payload));
      expect(readDraftDocument(document).body).toBe("Hello peer local");
      expect(requests.some((path) => path.endsWith("/lease"))).toBe(false);
      send.mockRestore();
    } finally {
      generations.mockRestore();
      document.destroy();
    }
  });

  test("restoring a recovery copy renews an expired own lease and retries once", async () => {
    jest.useFakeTimers();
    setSystemTime(Date.parse(now));
    const flush = async () => {
      for (let i = 0; i < 80; i++) await Promise.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    const { prompts, toast } = await import("@k2b/ui");
    const form = spyOn(prompts, "form").mockResolvedValue({ recoveryCopyId: "10000000-0000-4000-8000-000000000002" });
    const errors = spyOn(prompts, "error").mockResolvedValue(undefined);
    const restoredNotice = spyOn(toast, "success").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
    const fetchWithFixtures = globalThis.fetch;
    const restoreTokens: string[] = [];
    const operations: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost"), init);
        const path = new URL(request.url).pathname;
        if (path.endsWith("/recovery-copies"))
          return Response.json([
            {
              id: "10000000-0000-4000-8000-000000000002",
              draftId: "Draft1",
              baseRevision: 1,
              content: { ...draftEditableContentInputSchema.strip().parse(initialDraft), body: "Recovered text" },
              createdBy: initialDraft.createdBy,
              createdAt: now,
              restoredAt: null,
              resultingRevision: null,
            },
          ]);
        if (path.endsWith("/restore")) {
          const body = await request.json();
          restoreTokens.push(body.leaseToken);
          operations.push("restore");
          return restoreTokens.length === 1
            ? Response.json({ code: "DRAFT_LEASE_NOT_OWNED", message: "Lease expired" }, { status: 409 })
            : Response.json({ ...initialDraft, body: "Recovered text", revision: 2 });
        }
        if (path.endsWith("/lease") && request.method === "POST") {
          operations.push("acquire");
          return Response.json({
            token: operations.length === 1 ? "expired-token" : "renewed-token",
            holder: { kind: "user", id: "Usr001", displayName: "Ada", avatarHash: null },
            acquiredAt: now,
            expiresAt: now,
          });
        }
        return fetchWithFixtures(request);
      },
      { preconnect: originalFetch.preconnect },
    );
    try {
      await mount("en", { ...initialDraft, recoveryCopyCount: 1 }, undefined, undefined, flush);
      const recover = Array.from(dom.root.querySelectorAll("button")).find((button) => button.textContent?.includes("Recover changes"));
      expect(recover).toBeDefined();
      recover!.click();
      await flush();
      expect(restoreTokens).toEqual(["expired-token", "renewed-token"]);
      expect(operations).toEqual(["acquire", "restore", "acquire", "restore"]);
      expect(EditorView.findFromDOM(dom.root.querySelector<HTMLElement>(".cm-content")!)?.state.doc.toString()).toBe("Recovered text");
      expect(errors).not.toHaveBeenCalled();
      expect(restoredNotice).toHaveBeenCalledTimes(1);
    } finally {
      form.mockRestore();
      errors.mockRestore();
      restoredNotice.mockRestore();
      jest.useRealTimers();
    }
  });

  test("the first autosave keeps the body enabled and focused while acquiring the seed draft lease", async () => {
    jest.useFakeTimers();
    setSystemTime(Date.parse(now));
    const flush = async () => {
      for (let i = 0; i < 80; i++) await Promise.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    const fetchWithFixtures = globalThis.fetch;
    const hashing = Promise.withResolvers<void>();
    const continueHashing = Promise.withResolvers<void>();
    const updated = Promise.withResolvers<void>();
    const originalHash = cryptoUtils.common.hash;
    const hash = spyOn(cryptoUtils.common, "hash").mockImplementation(async (...args) => {
      hashing.resolve();
      await continueHashing.promise;
      return originalHash(...args);
    });
    let grant: ((response: Response) => void) | undefined;
    let heartbeats = 0;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost"), init);
        if (request.method === "POST" && new URL(request.url).pathname.endsWith("/lease")) {
          return new Promise<Response>((resolve) => {
            grant = resolve;
          });
        }
        if (request.method === "PUT" && new URL(request.url).pathname.endsWith("/lease")) heartbeats++;
        const response = await fetchWithFixtures(request);
        if (request.method === "PUT" && new URL(request.url).pathname.endsWith("/drafts/Draft1")) updated.resolve();
        return response;
      },
      { preconnect: originalFetch.preconnect },
    );
    try {
      await mount("en", initialDraft, undefined, initialSeed, flush);
      const editor = dom.root.querySelector<HTMLElement>(".cm-content")!;
      const view = EditorView.findFromDOM(editor)!;
      editor.focus();
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "First lines" } });
      jest.advanceTimersByTime(700);
      await flush();
      expect(saves).toHaveLength(1);
      expect(grant).toBeDefined();
      expect(view.state.readOnly).toBe(false);
      expect(dom.document.activeElement).toBe(editor);
      // Text typed while the lease is pending survives a reload: the materialized draft keeps its journal.
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "First lines and more" } });
      await flush();
      expect(JSON.parse(localStorage.getItem("cloud:user:Usr001:mail:cloud:mail:draft:Box001:Draft1") ?? "null")?.content?.body).toBe(
        "First lines and more",
      );
      grant?.(
        Response.json({
          token: "seed-token",
          holder: { kind: "user", id: "Usr001", displayName: "Ada", avatarHash: null },
          acquiredAt: now,
          expiresAt: now,
        }),
      );
      await hashing.promise;
      await flush();
      expect(saves).toHaveLength(1);
      expect(view.state.readOnly).toBe(false);
      expect(dom.document.activeElement).toBe(editor);
      expect(view.state.doc.toString()).toBe("First lines and more");
      continueHashing.resolve();
      // SHA-256 runs outside the fake timer/microtask queue. Await the PUT,
      // rather than assuming one event-loop turn finishes the native digest.
      await updated.promise;
      await flush();
      expect(view.state.readOnly).toBe(false);
      expect(dom.document.activeElement).toBe(editor);
      expect(view.state.doc.toString()).toBe("First lines and more");
      expect(saves.map((save) => save.body)).toEqual(["First lines", "First lines and more"]);
      jest.advanceTimersByTime(10_000);
      await flush();
      expect(heartbeats).toBe(1);
      expect(saves).toHaveLength(2);
    } finally {
      continueHashing.resolve();
      hash.mockRestore();
      jest.useRealTimers();
    }
  });

  test("an own live invalidation keeps the focused body editor enabled", async () => {
    jest.useFakeTimers();
    setSystemTime(Date.parse(now));
    const flush = async () => {
      for (let i = 0; i < 80; i++) await Promise.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    const fetchWithFixtures = globalThis.fetch;
    let finishHeartbeat: ((response: Response) => void) | undefined;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost"), init);
        if (request.method === "PUT" && new URL(request.url).pathname.endsWith("/lease")) {
          return new Promise<Response>((resolve) => {
            finishHeartbeat = resolve;
          });
        }
        return fetchWithFixtures(request);
      },
      { preconnect: originalFetch.preconnect },
    );
    try {
      await mount("en", initialDraft, undefined, undefined, flush);
      const editor = dom.root.querySelector<HTMLElement>(".cm-content");
      const view = EditorView.findFromDOM(editor!)!;
      expect(editor).not.toBeNull();
      expect(view.state.readOnly).toBe(false);
      editor!.focus();
      expect(dom.document.activeElement).toBe(editor);
      const socket = OfflineWebSocket.instances.at(-1)!;
      socket.open();
      socket.message({ t: "ready", id: "1", cursor: "s6t.mail.4" });
      socket.message({ t: "event", id: "1", cursor: "s6t.mail.5", data: { conversationId: null } });
      await flush();
      expect(finishHeartbeat).toBeDefined();
      expect(view.state.readOnly).toBe(false);
      expect(dom.document.activeElement).toBe(editor);
      finishHeartbeat?.(
        Response.json({
          token: "local-token",
          holder: { kind: "user", id: "Usr001", displayName: "Ada Example", avatarHash: null },
          acquiredAt: now,
          expiresAt: now,
        }),
      );
      await flush();
      expect(view.state.readOnly).toBe(false);
      expect(dom.document.activeElement).toBe(editor);
    } finally {
      jest.useRealTimers();
    }
  });

  test("Attach files passes localized context and resolves the click-time To, Cc and Bcc snapshot lazily", async () => {
    const files = await import("@k2b/cloud/browser/files");
    const capabilities = await import("@k2b/cloud/capabilities");
    const chooseFiles = spyOn(files, "chooseFiles").mockResolvedValue([]);
    const listCatalog = spyOn(capabilities, "listCapabilityCatalog").mockResolvedValue({
      ok: true,
      data: {
        protocolVersion: 2,
        apps: [
          {
            appId: "customers",
            appName: "Customers",
            appIcon: "ti ti-users",
            appDescription: "",
            manifest: compileCapabilityManifest(
              "customers",
              defineCapabilities({
                protocolVersion: 2,
                queries: {
                  "customer.match": {
                    title: "Match customers",
                    description: "Resolve readable customers.",
                    openWorld: false,
                    input: contactDirectory.resolve.input,
                    data: contactDirectory.resolve.data,
                    run: async () => ({ ok: false, error: { code: "INTERNAL", message: "Not called", status: 500 } }),
                  },
                },
              }),
            ),
          },
        ],
        page: { hasMore: false },
      },
    });
    const invoke = spyOn(capabilities, "invokeCapabilityWithDataSchema").mockResolvedValue({
      ok: true,
      data: { data: { items: [{ ref: { type: "customers.customer", id: "c1" }, matchedEmails: ["recipient@example.test"] }] } },
    });
    try {
      await mount("de", {
        ...initialDraft,
        cc: [{ name: null, address: "cc@example.test" }],
        bcc: [{ name: null, address: "bcc@example.test" }],
      });
      const attach = dom.root.querySelector<HTMLButtonElement>('button[aria-label="Dateien anhängen"]');
      expect(attach).not.toBeNull();
      attach!.click();
      // chooseFiles must run in the click handler, before an import or a contact lookup.
      expect(chooseFiles).toHaveBeenCalledTimes(1);
      expect(listCatalog).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
      const options = chooseFiles.mock.calls[0]![0]!;
      expect(options).toMatchObject({
        multiple: true,
        maxTotalBytes: MAX_DRAFT_ATTACHMENT_BYTES,
        noMatchingFiles: "Keine passenden Dateien für diese Empfänger",
      });
      expect(typeof options.context).toBe("function");
      const toInput = dom.root.querySelector<HTMLInputElement>(".mail-recipient-input input");
      expect(toInput).not.toBeNull();
      toInput!.value = "changed@example.test";
      toInput!.dispatchEvent(new Event("input", { bubbles: true }));
      toInput!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(dom.root.textContent).toContain("changed@example.test");
      if (typeof options.context !== "function") throw new Error("Missing lazy context");
      expect(await options.context(new AbortController().signal)).toEqual({ refs: [{ type: "customers.customer", id: "c1" }] });
      expect(invoke.mock.calls[0]![0]).toMatchObject({
        appId: "customers",
        capabilityId: "customer.match",
        kind: "query",
        input: { emails: ["recipient@example.test", "cc@example.test", "bcc@example.test"], limit: 50 },
      });
    } finally {
      chooseFiles.mockRestore();
      listCatalog.mockRestore();
      invoke.mockRestore();
    }
  });

  test("attachment context failures show the localized message and preserve caller cancellation", async () => {
    const files = await import("@k2b/cloud/browser/files");
    const capabilities = await import("@k2b/cloud/capabilities");
    const reload = await import("@k2b/cloud/browser/reload");
    const chooseFiles = spyOn(files, "chooseFiles").mockResolvedValue([]);
    const listCatalog = spyOn(capabilities, "listCapabilityCatalog").mockRejectedValue(new Error("Offline"));
    try {
      await mount("de");
      dom.root.querySelector<HTMLButtonElement>('button[aria-label="Dateien anhängen"]')!.click();
      const options = chooseFiles.mock.calls[0]![0]!;
      if (typeof options.context !== "function") throw new Error("Missing lazy context");
      await expect(options.context(new AbortController().signal)).rejects.toThrow(
        "Die Kontakte dieser Empfänger konnten nicht nachgeschlagen werden",
      );
      const importOnDemand = spyOn(reload, "importOnDemand").mockResolvedValue(undefined);
      try {
        await expect(options.context(new AbortController().signal)).rejects.toThrow(
          "Die Kontakte dieser Empfänger konnten nicht nachgeschlagen werden",
        );
        const controller = new AbortController();
        const reason = new Error("Caller cancelled");
        controller.abort(reason);
        await expect(options.context(controller.signal)).rejects.toBe(reason);
      } finally {
        importOnDemand.mockRestore();
      }
    } finally {
      chooseFiles.mockRestore();
      listCatalog.mockRestore();
    }
  });

  test("Attach files without recipients keeps the chooser's generic empty title", async () => {
    const files = await import("@k2b/cloud/browser/files");
    const chooseFiles = spyOn(files, "chooseFiles").mockResolvedValue([]);
    try {
      await mount("en", { ...initialDraft, to: [], cc: [], bcc: [] });
      dom.root.querySelector<HTMLButtonElement>('button[aria-label="Attach files"]')!.click();
      expect(chooseFiles).toHaveBeenCalledTimes(1);
      expect(chooseFiles.mock.calls[0]![0]).not.toHaveProperty("noMatchingFiles");
    } finally {
      chooseFiles.mockRestore();
    }
  });

  test("shows the draft choice and sends null in the next autosave and preview after No signature", async () => {
    await mount();
    expect(trigger().textContent).toContain("Personal signature");
    expect(trigger().getAttribute("aria-label")).toBe("Signature: Personal signature");
    const footer = dom.root.querySelector("footer")!;
    const buttons = Array.from(footer.querySelectorAll("button:not([role])"));
    const signatureIndex = buttons.indexOf(trigger());
    expect(buttons[signatureIndex - 1]?.textContent).toContain("Write with AI");
    expect(buttons[signatureIndex + 1]?.getAttribute("aria-label")).toBe("Message options");
    expect(dom.root.querySelectorAll(".mail-composer-signature")).toHaveLength(1);
    expect(footer.contains(dom.root.querySelector(".mail-composer-signature"))).toBe(true);
    trigger().click();
    choose("No signature");
    expect(trigger().textContent).toContain("None");
    expect(trigger().getAttribute("aria-label")).toBe("Signature: None");
    await waitFor(() => saves.length > 0 && previews.some((content) => content.signatureTemplateId === null));
    expect(saves.at(-1)?.signatureTemplateId).toBeNull();
    expect(saves.at(-1)?.body).toBe("Hello");
    expect(previews.at(-1)?.signatureTemplateId).toBeNull();
    expect(dom.root.querySelector(".mail-composer-signature")).not.toBeNull();
  });

  test("marks the sender default as the current radio choice", async () => {
    await mount("en", { ...initialDraft, signatureTemplateId: "Sign01" });
    expect(trigger().textContent).toContain("Support signature");
    trigger().click();
    const items = Array.from(dom.document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'));
    expect(items).toHaveLength(4);
    for (const item of items) {
      const isDefault = Boolean(item.textContent?.includes("Support signature"));
      expect(item.getAttribute("aria-checked")).toBe(String(isDefault));
      if (isDefault) expect(item.querySelector("small")?.textContent).toBe("Default");
    }
  });

  test("omits the signature button when the initial draft has no choice or templates", async () => {
    await mount("en", { ...initialDraft, signatureTemplateId: null }, []);
    expect(dom.root.querySelector(".mail-composer-signature")).toBeNull();
  });

  test("a sender menu change uses that sender's personal default", async () => {
    await mount();
    dom.root.querySelector<HTMLButtonElement>('button[aria-label^="Change sender identity"]')!.click();
    choose("Sales · sales@example.test", "menuitem");
    expect(trigger().textContent).toContain("Sales signature");
    await waitFor(() => saves.length > 0);
    expect(saves.at(-1)).toMatchObject({ senderIdentityId: "Send02", signatureTemplateId: "Sign03" });
  });

  test("renders the button and No signature choice in German", async () => {
    await mount("de");
    expect(trigger().getAttribute("aria-label")).toBe("Signatur: Personal signature");
    trigger().click();
    choose("Keine Signatur");
    expect(trigger().textContent).toContain("Keine");
    expect(trigger().getAttribute("aria-label")).toBe("Signatur: Keine");
  });

  test("preserves an unavailable private signature on a shared draft", async () => {
    await mount("en", { ...initialDraft, signatureTemplateId: "Other1" }, []);
    expect(trigger().textContent).toContain("Signature of another person");
    await waitFor(() => previews.length > 0);
    expect(previews.at(-1)?.signatureTemplateId).toBe("Other1");
    expect(saves).toEqual([]);
    trigger().click();
    choose("No signature");
    await waitFor(() => saves.length > 0);
    expect(trigger().textContent).toContain("None");
    expect(dom.root.querySelector(".mail-composer-signature")).not.toBeNull();
  });

  test("keeps a seed signature clean until a change, then materializes the chosen signature", async () => {
    await mount("en", initialDraft, undefined, initialSeed);
    expect(trigger().textContent).toContain("Personal signature");
    await Bun.sleep(800);
    expect(saves).toEqual([]);
    trigger().click();
    choose("No signature");
    await waitFor(() => saves.length > 0);
    expect(saves[0]).toMatchObject({ signatureTemplateId: null, body: "Hello" });
  });

  test("unowned legacy device input is neither displayed nor deleted by a new user session", async () => {
    const raw = JSON.stringify({ revision: 1, content: { ...initialDraft, body: "Unknown owner's private text" } });
    localStorage.setItem("cloud:mail:draft:Box001:Draft1", raw);
    await mount();
    expect(localStorage.getItem("cloud:mail:draft:Box001:Draft1")).toBe(raw);
    expect(dom.root.textContent).not.toContain("Unknown owner's private text");
    expect(saves.some((saved) => saved.body.includes("Unknown owner's private text"))).toBe(false);
  });

  test("local recovery restores its signature without selecting the sender default", async () => {
    localStorage.setItem(
      "cloud:user:Usr001:mail:cloud:mail:draft:Box001:Draft1",
      JSON.stringify({
        revision: 1,
        content: {
          quoteSource: null,
          senderIdentityId: "Send01",
          signatureTemplateId: null,
          to: initialDraft.to,
          cc: [],
          bcc: [],
          subject: "Offer",
          body: "Recovered",
          format: "markdown",
          priority: "normal",
          requestDeliveryReceipt: false,
          requestReadReceipt: false,
        },
      }),
    );
    await mount();
    await waitFor(() => Boolean(trigger().textContent?.includes("None")));
    await waitFor(() => saves.length > 0);
    expect(saves.at(-1)).toMatchObject({ signatureTemplateId: null, body: "Recovered" });
  });

  test("local recovery preserves an inline signature from a journal without a signature choice", async () => {
    localStorage.setItem(
      "cloud:user:Usr001:mail:cloud:mail:draft:Box001:Draft1",
      JSON.stringify({
        revision: 1,
        content: {
          quoteSource: null,
          senderIdentityId: "Send01",
          to: initialDraft.to,
          cc: [],
          bcc: [],
          subject: "Offer",
          body: "Recovered\n\n\u2063Best regards\u2064",
          format: "markdown",
          priority: "normal",
          requestDeliveryReceipt: false,
          requestReadReceipt: false,
        },
      }),
    );
    await mount();
    await waitFor(() => Boolean(trigger().textContent?.includes("None")));
    await waitFor(() => saves.length > 0);
    expect(saves.at(-1)).toMatchObject({ signatureTemplateId: null, body: "Recovered\n\n\u2063Best regards\u2064" });
  });
});

describe("MailComposer robustness", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  let dom: DomTestHarness;
  let dispose = () => {};
  let saves: DraftEditableContent[];
  let requests: string[];
  let lease: Promise<void>;
  let leaves: string[];
  let opened: string[];

  beforeEach(() => {
    dom = createDomTestHarness();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: OfflineWebSocket });
    installPopover();
    delegateEvents(["click", "keydown", "input"]);
    saves = [];
    requests = [];
    leaves = [];
    opened = [];
    lease = Promise.resolve();
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost"), init);
        const path = new URL(request.url).pathname;
        requests.push(`${request.method} ${path}`);
        if (path.endsWith("/lease")) {
          await lease;
          return Response.json({
            token: crypto.randomUUID(),
            holder: { kind: "user", id: "Usr001", displayName: "Ada", avatarHash: null },
            acquiredAt: now,
            expiresAt: now,
          });
        }
        if (path.endsWith("/compose-preview")) return Response.json({ html: "<p>Hello</p>", text: "Hello", formattingWarnings: [] });
        if (path.endsWith("/draft-seeds/materialize")) {
          const json = materializeDraftSeedInputSchema.parse(await request.json());
          saves.push(json.draft);
          return Response.json({ ...initialDraft, ...json.draft });
        }
        if (path.endsWith("/drafts/Draft1") && request.method === "GET") return Response.json(initialDraft);
        if (path.endsWith("/drafts/Draft1") && request.method === "PUT") {
          const json = z
            .object({ expectedRevision: z.number().int().positive(), draft: draftEditableContentInputSchema })
            .parse(await request.json());
          saves.push(json.draft);
          return Response.json({ ...initialDraft, ...json.draft, revision: json.expectedRevision + 1 });
        }
        if (path.endsWith("/safety-review"))
          return Response.json({ revision: 2, fingerprint: "f".repeat(64), warnings: [], contentHash: "a".repeat(64) });
        if (path.endsWith("/commands")) return Response.json({ id: crypto.randomUUID(), result: {} });
        if (path.endsWith("/discard")) return Response.json({ ...initialDraft, state: "discarded" });
        throw new Error(`Unexpected request: ${request.method} ${path}`);
      },
      { preconnect: originalFetch.preconnect },
    );
  });
  afterEach(async () => {
    dispose();
    await Bun.sleep(30);
    globalThis.fetch = originalFetch;
    for (const [key, descriptor] of [
      ["localStorage", originalStorage],
      ["WebSocket", originalWebSocket],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.cleanup();
  });

  const mount = async (
    options: {
      host?: boolean;
      popout?: boolean;
      draft?: MailDraft;
      seed?: MailDraftSeed;
      templates?: { id: string; name: string }[];
      canShareAttachments?: boolean;
      ready?: boolean;
    } = {},
  ) => {
    const [{ default: MailComposer }, { LocaleProvider }] = await Promise.all([import("./MailComposer"), import("@k2b/ui")]);
    const draft = options.seed ? undefined : (options.draft ?? initialDraft);
    dispose = render(
      () => (
        <LocaleProvider locale="en">
          <MailComposer
            mailboxId="Box001"
            currentActor={{ kind: "user", id: "Usr001" }}
            identities={[identity("Send01", "Support", "Sign01")]}
            signatures={{ templates: options.templates ?? [], personalDefaults: [] }}
            initialDraft={draft}
            initialSeed={options.seed}
            initialPanes={{ version: 2, root: { type: "group", items: ["editor", "preview"], active: "editor" } }}
            returnHref="/app/mail/Box001"
            popout={options.popout}
            canShareAttachments={options.canShareAttachments}
            dateConfig={{ locale: "en", timeZone: "UTC" }}
            host={
              options.host
                ? {
                    fresh: false,
                    fullscreen: () => false,
                    toggleFullscreen: () => undefined,
                    register: () => undefined,
                    messageLabel: () => null,
                    leave: (outcome) => leaves.push(outcome),
                    openDraft: (draftId) => opened.push(draftId),
                  }
                : undefined
            }
          />
        </LocaleProvider>
      ),
      dom.root,
    );
    await waitFor(() => Boolean(dom.root.querySelector(".cm-content")));
    if (options.ready !== false) await waitFor(() => Boolean(sendButton() && !sendButton().disabled));
  };
  const sendButton = () => dom.root.querySelector<HTMLButtonElement>("button.mail-compose-action")!;
  const recipientInput = () => dom.root.querySelector<HTMLInputElement>(".mail-recipient-input input")!;
  const view = () => EditorView.findFromDOM(dom.root.querySelector<HTMLElement>(".cm-editor")!)!;
  const type = (input: HTMLInputElement, value: string) => {
    input.focus();
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const sendShortcut = (target: Element) =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
  const sent = () => requests.some((request) => request.endsWith("/commands"));

  test.each(["bernd", "bernd@firma"])("unfinished recipient text %p blocks Send, stays, and takes the focus", async (typed) => {
    await mount({ host: true });
    type(recipientInput(), typed);
    sendButton().click();
    await Bun.sleep(80);
    expect(requests.some((request) => request.endsWith("/safety-review"))).toBe(false);
    expect(sent()).toBe(false);
    expect(recipientInput().value).toBe(typed);
    expect(recipientInput().getAttribute("aria-invalid")).toBe("true");
    expect(dom.document.activeElement).toBe(recipientInput());
    expect(dom.root.textContent).toContain("is not sent yet");
  });

  test("complete recipient text goes with the message although nobody pressed Enter", async () => {
    await mount({ host: true });
    type(recipientInput(), "Bernd <bernd@firma.de>");
    sendButton().click();
    await waitFor(sent);
    expect(saves.at(-1)?.to).toEqual([
      { name: null, address: "recipient@example.test" },
      { name: "Bernd", address: "bernd@firma.de" },
    ]);
    await waitFor(() => leaves.includes("sent"));
  });

  test.each([false, true])("Ctrl+Enter sends with the button's checks (inline %p), and the button names it", async (host) => {
    await mount({ host });
    sendButton().dispatchEvent(new MouseEvent("pointerenter", { bubbles: true }));
    sendButton().focus();
    await waitFor(() => Boolean(dom.document.body.textContent?.includes("Send (Ctrl+↵)")));
    type(recipientInput(), "bernd");
    sendShortcut(view().contentDOM);
    await Bun.sleep(80);
    expect(sent()).toBe(false);
    expect(dom.document.activeElement).toBe(recipientInput());
    type(recipientInput(), "bernd@firma.de");
    sendShortcut(recipientInput());
    await waitFor(sent);
    expect(saves.at(-1)?.to.map((recipient) => recipient.address)).toContain("bernd@firma.de");
  });

  test("a send keeps the text focused, its toolbar in place, and the text unchanged while it waits", async () => {
    await mount();
    const review = Promise.withResolvers<void>();
    let reviewing = false;
    const serve = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith("/safety-review")) {
          reviewing = true;
          await review.promise;
        }
        return serve(input, init);
      },
      { preconnect: originalFetch.preconnect },
    );
    view().focus();
    view().dispatch({ selection: { anchor: 3 } });
    const toolbar = dom.root.querySelector(".k2b-ste-toolbar");
    expect(toolbar).not.toBeNull();
    sendButton().click();
    await waitFor(() => reviewing);
    expect(dom.root.querySelector(".k2b-ste-toolbar")).toBe(toolbar);
    expect(view().contentDOM.getAttribute("contenteditable")).toBe("true");
    expect(view().state.readOnly).toBe(true);
    expect(dom.document.activeElement).toBe(view().contentDOM);
    review.resolve();
    await waitFor(sent);
  });

  test("an opening draft shows its toolbar at once, and the inline reply takes the caret once the lease arrives", async () => {
    const granted = Promise.withResolvers<void>();
    lease = granted.promise;
    await mount({ host: true, ready: false, draft: { ...initialDraft, conversationId: "Conv01", intent: "reply" } });
    await Bun.sleep(30);
    expect(dom.document.activeElement).not.toBe(view().contentDOM);
    expect(view().contentDOM.getAttribute("contenteditable")).toBe("true");
    granted.resolve();
    await waitFor(() => !sendButton().disabled);
    await waitFor(() => dom.document.activeElement === view().contentDOM);
  });

  test("a focus chosen before the lease arrives stays where the person put it", async () => {
    const granted = Promise.withResolvers<void>();
    lease = granted.promise;
    await mount({ host: true, ready: false, draft: { ...initialDraft, conversationId: "Conv01", intent: "reply" } });
    const subject = dom.root.querySelector<HTMLInputElement>('input[aria-label="Subject"]')!;
    subject.focus();
    granted.resolve();
    await waitFor(() => !sendButton().disabled);
    await Bun.sleep(30);
    expect(dom.document.activeElement).toBe(subject);
  });

  test("Esc that ends a Safari IME composition keeps the draft open", async () => {
    await mount({ host: true });
    let collapsed = false;
    const section = dom.root.querySelector<HTMLElement>("[data-mail-inline-draft]")!;
    section.addEventListener("keydown", (event) => {
      if (event.defaultPrevented) collapsed = true;
    });
    view().contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 229, bubbles: true, cancelable: true }));
    await Bun.sleep(30);
    expect(collapsed).toBe(false);
    expect(leaves).toEqual([]);
  });

  test("discarding a new message that was never saved asks first when it holds input", async () => {
    const nav = await import("@k2b/ssr/nav");
    const navigate = spyOn(nav, "navigateTo").mockImplementation(() => undefined as never);
    try {
      await mount({ seed: { ...initialSeed, content: { ...initialSeed.content, body: "" } }, ready: false });
      view().dispatch({ changes: { from: 0, insert: "Important words" }, userEvent: "input.type" });
      dom.root.querySelector<HTMLButtonElement>('footer button[aria-label="Discard draft"]')!.click();
      await waitFor(() => Boolean(dom.document.body.textContent?.includes("Discard draft?")));
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      navigate.mockRestore();
    }
  });

  test("discarding a new message asks first when only a recipient field holds typed text", async () => {
    const nav = await import("@k2b/ssr/nav");
    const navigate = spyOn(nav, "navigateTo").mockImplementation(() => undefined as never);
    try {
      await mount({ seed: initialSeed, ready: false });
      type(recipientInput(), "Bernd");
      dom.root.querySelector<HTMLButtonElement>('footer button[aria-label="Discard draft"]')!.click();
      await waitFor(() => Boolean(dom.document.body.textContent?.includes("Discard draft?")));
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      navigate.mockRestore();
    }
  });

  test("a popout closes its window after Send instead of loading the mailbox into it", async () => {
    const nav = await import("@k2b/ssr/nav");
    const navigate = spyOn(nav, "navigateTo").mockImplementation(() => undefined as never);
    const close = spyOn(dom.window, "close").mockImplementation(() => undefined);
    try {
      await mount({ popout: true });
      sendButton().click();
      await waitFor(sent);
      await waitFor(() => close.mock.calls.length > 0);
      expect(navigate).not.toHaveBeenCalled();
      // A browser that keeps the window open shows a short confirmation in place.
      await waitFor(() => Boolean(dom.root.textContent?.includes("You can close this window")));
      // The covered composer leaves the keyboard and screen readers; the confirmation takes the focus.
      expect(dom.root.querySelector<HTMLElement>("footer")!.closest("[inert]")).not.toBeNull();
      expect(dom.document.activeElement?.textContent).toContain("Close window");
    } finally {
      navigate.mockRestore();
      close.mockRestore();
    }
  });

  test("a signature that arrives after opening can be removed again", async () => {
    localStorage.setItem(
      "cloud:user:Usr001:mail:cloud:mail:draft:Box001:Draft1",
      JSON.stringify({
        revision: 1,
        content: { ...draftEditableContentInputSchema.strip().parse(initialDraft), signatureTemplateId: "Other1" },
      }),
    );
    await mount({ draft: { ...initialDraft, signatureTemplateId: null } });
    await waitFor(() => Boolean(dom.root.querySelector("footer button.mail-composer-signature")));
  });

  test("Undo takes back an inserted attachment link and nothing typed before it", async () => {
    const linkUi = await import("./attachment-link-ui");
    const prompt = spyOn(linkUi, "promptAttachmentLinkOptions").mockResolvedValue({ expiresAt: null, password: null });
    const serve = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes("/links")) return Response.json({ link: { filename: "report.pdf" }, url: "https://cloud.example.test/l/abc" });
        return serve(input, init);
      },
      { preconnect: originalFetch.preconnect },
    );
    try {
      await mount({
        canShareAttachments: true,
        draft: {
          ...initialDraft,
          attachments: [
            {
              id: "Att001",
              filename: "report.pdf",
              contentType: "application/pdf",
              byteLength: 10,
              contentHash: "b".repeat(64),
              position: 0,
              createdAt: now,
            },
          ],
        },
      });
      const { undo } = await import("@codemirror/commands");
      view().dispatch({ changes: { from: view().state.doc.length, insert: " world" }, userEvent: "input.type" });
      dom.root.querySelector<HTMLButtonElement>('button[aria-label="Insert public link for report.pdf"]')!.click();
      await waitFor(() => view().state.doc.toString().includes("https://cloud.example.test/l/abc"));
      undo(view());
      expect(view().state.doc.toString()).toBe("Hello world");
    } finally {
      prompt.mockRestore();
    }
  });
});
