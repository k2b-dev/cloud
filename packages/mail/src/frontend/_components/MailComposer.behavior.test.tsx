import { afterEach, beforeEach, describe, expect, jest, setSystemTime, spyOn, test } from "bun:test";
import { setImmediate } from "node:timers";
import { EditorView } from "@codemirror/view";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { contactDirectory, defineCapabilities } from "@k2b/cloud/contracts";
import { encoding } from "@k2b/stdlib";
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
  afterEach(() => {
    dispose();
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
        return fetchWithFixtures(request);
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
        maxBytes: MAX_DRAFT_ATTACHMENT_BYTES,
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
