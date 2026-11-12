import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { encoding } from "@k2b/stdlib";
import { createSignal } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { createDomTestHarness, type DomTestHarness } from "../../../../ui/test/dom";
import { draftEditableContentInputSchema, type MailDraft, type SenderIdentity } from "../../contracts";
import { createDraftDocument, DRAFT_BODY } from "../../lib/draft-document";
import type { MailComposerHost } from "./MailComposer";
import type { UnfinishedDraftUpload } from "./mail-composer-attachment-manager";

// The composer as a floating window's content: status in the window's head, Send in the head on a phone, and the
// states of the bottom bar. The window itself is `MailComposeWindows`.
const now = "2026-10-11T10:00:00.000Z";
const identity: SenderIdentity = {
  id: "Send01",
  mailboxId: "Box001",
  label: "Support",
  displayName: "Support",
  fromAddress: "support@example.test",
  replyTo: null,
  defaultCc: [],
  defaultBcc: [],
  defaultFormat: "markdown",
  defaultPriority: "normal",
  defaultDeliveryReceipt: false,
  defaultReadReceipt: false,
  vcard: null,
  envelopeSender: null,
  defaultSignatureTemplateId: null,
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
  isDefault: true,
  status: "verified",
  statusReason: null,
  pendingVerificationCommandId: null,
  createdAt: now,
  updatedAt: now,
};
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
  signatureTemplateId: null,
  to: [{ name: null, address: "saegewerk@example.test" }],
  cc: [],
  bcc: [],
  subject: "Oak planks, 52 mm",
  body: "Good morning",
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

class OfflineWebSocket {
  static instances: OfflineWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose = null;
  onerror = null;
  constructor(readonly url?: string) {
    OfflineWebSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  send(_data: string) {}
  close() {
    this.readyState = 3;
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

/** Waits until the condition holds; the test's own timeout bounds the wait. */
const waitFor = async (condition: () => boolean) => {
  while (!condition()) await Bun.sleep(5);
};

describe("MailComposer in a floating window", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const originalOnline = Object.getOwnPropertyDescriptor(navigator, "onLine");
  let dom: DomTestHarness;
  let dispose = () => {};
  let requests: string[];
  let commandFailure: string | null;
  let leaves: string[];
  let delivered: Parameters<NonNullable<MailComposerHost["delivered"]>>[0][];
  let statusSlot: HTMLElement;
  let actionsSlot: HTMLElement;
  let setSheet: (value: boolean) => void;
  let documentResponse: ((path: string) => Response | null) | null;

  beforeEach(() => {
    dom = createDomTestHarness();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: OfflineWebSocket });
    OfflineWebSocket.instances = [];
    installPopover();
    delegateEvents(["click", "keydown", "input"]);
    requests = [];
    commandFailure = null;
    leaves = [];
    delivered = [];
    documentResponse = null;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost"), init);
        const path = new URL(request.url).pathname;
        requests.push(`${request.method} ${path}`);
        const shared = documentResponse?.(path);
        if (shared) return shared;
        if (path.endsWith("/lease") && request.method === "GET") return Response.json(null);
        if (path.endsWith("/lease"))
          return Response.json({
            token: crypto.randomUUID(),
            holder: { kind: "user", id: "Usr001", displayName: "Ada", avatarHash: null },
            acquiredAt: now,
            expiresAt: now,
          });
        if (path.endsWith("/drafts/Draft1") && request.method === "PUT") {
          const json = (await request.json()) as { expectedRevision: number; draft: object };
          return Response.json({ ...initialDraft, ...json.draft, revision: json.expectedRevision + 1 });
        }
        if (path.endsWith("/safety-review"))
          return Response.json({ revision: 1, fingerprint: "f".repeat(64), warnings: [], contentHash: "a".repeat(64) });
        if (path.endsWith("/commands")) {
          if (commandFailure) return Response.json({ code: "SEND_FAILED", message: commandFailure }, { status: 503 });
          return Response.json({ id: crypto.randomUUID(), result: { outboxSubmissionId: "Dlv001", conversationId: "Conv01" } });
        }
        throw new Error(`Unexpected request: ${request.method} ${path}`);
      },
      { preconnect: originalFetch.preconnect },
    );
  });
  afterEach(async () => {
    dispose();
    await Bun.sleep(30);
    globalThis.fetch = originalFetch;
    if (originalOnline) Object.defineProperty(navigator, "onLine", originalOnline);
    else Reflect.deleteProperty(navigator, "onLine");
    for (const [key, descriptor] of [
      ["localStorage", originalStorage],
      ["WebSocket", originalWebSocket],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.cleanup();
  });

  const mount = async (options: { draft?: MailDraft; uploads?: UnfinishedDraftUpload[]; sheet?: boolean; ready?: boolean } = {}) => {
    const [{ default: MailComposer }, { LocaleProvider }] = await Promise.all([import("./MailComposer"), import("@k2b/ui")]);
    statusSlot = dom.document.createElement("span");
    actionsSlot = dom.document.createElement("span");
    const head = dom.document.createElement("header");
    head.append(statusSlot, actionsSlot);
    dom.root.before(head);
    dispose = render(() => {
      const [sheet, set] = createSignal(options.sheet ?? false);
      setSheet = set;
      return (
        <LocaleProvider locale="en">
          <MailComposer
            mailboxId="Box001"
            currentActor={{ kind: "user", id: "Usr001" }}
            identities={[identity]}
            signatures={{ templates: [], personalDefaults: [] }}
            initialDraft={options.draft ?? initialDraft}
            unfinishedUploads={options.uploads}
            initialPanes={{ version: 2, root: { type: "group", items: ["editor", "preview"], active: "editor" } }}
            returnHref="/app/mail/Box001"
            dateConfig={{ locale: "en", timeZone: "UTC" }}
            host={{
              fresh: false,
              fullscreen: () => false,
              toggleFullscreen: () => undefined,
              register: () => undefined,
              messageLabel: () => null,
              leave: (outcome) => leaves.push(outcome),
              openDraft: () => undefined,
              window: { status: () => statusSlot, actions: () => actionsSlot, sheet },
              delivered: (value) => delivered.push(value),
            }}
          />
        </LocaleProvider>
      );
    }, dom.root);
    await waitFor(() => Boolean(dom.root.querySelector(".cm-content")));
    if (options.ready !== false) await waitFor(() => Boolean(sendButton() && !sendButton()!.disabled));
  };
  // The Send split button carries the composer's class on the whole control; Send is its main segment.
  const sendButton = () => dom.document.querySelector<HTMLButtonElement>(".mail-compose-action .k2b-split-button__primary");
  const status = () => statusSlot.textContent?.trim() ?? "";
  const foot = () => dom.root.querySelector<HTMLElement>(".mail-compose-window-foot")!;

  test("the window's head carries the save status; the bar starts with Send and ends with the trash", async () => {
    await mount();
    await waitFor(() => status() === "Saved on server");
    expect(statusSlot.querySelector("[role=status]")).not.toBeNull();
    // The window has its own Minimize, Maximize, and Close; the draft shows no intent, full screen, or collapse.
    expect(dom.root.querySelector(".mail-inline-draft-intent")).toBeNull();
    expect(dom.root.querySelector("[data-mail-draft-fullscreen]")).toBeNull();
    expect(dom.root.querySelector("[data-mail-draft-collapse]")).toBeNull();
    expect(dom.root.querySelector(".mail-inline-draft-foot .mail-inline-draft-status")).toBeNull();
    const controls = [...foot().querySelectorAll("button")].filter((button) => !button.closest(".k2b-split-button__menu"));
    expect(controls[0]).toBe(sendButton()!);
    expect(controls.at(-1)?.getAttribute("aria-label")).toBe("Discard draft");
    expect(foot().querySelector('[aria-label="Draft actions"]')).not.toBeNull();
  });

  test("a send that fails keeps the window; the bar turns red with the reason and Send again", async () => {
    await mount();
    commandFailure = "The mail server is not reachable.";
    sendButton()!.click();
    await waitFor(() => foot().getAttribute("data-tone") === "danger");
    expect(foot().querySelector("[data-mail-send-failure]")?.textContent).toBe(
      "Not sent: The mail server is not reachable. Your text is saved.",
    );
    expect(sendButton()!.textContent).toContain("Send again");
    expect(dom.document.querySelector("dialog[open]")).toBeNull();
    expect(leaves).toEqual([]);
    commandFailure = null;
    sendButton()!.click();
    await waitFor(() => leaves.includes("sent"));
    expect(delivered).toEqual([{ submissionId: "Dlv001", scheduledAt: null, undoSeconds: expect.any(Number) }]);
  });

  test("a sent message leaves the window and hands the host its delivery for Undo instead of the composer's notice", async () => {
    await mount();
    sendButton()!.click();
    await waitFor(() => leaves.includes("sent"));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.submissionId).toBe("Dlv001");
    expect(dom.document.body.textContent).not.toContain("You can undo it directly in the conversation");
  });

  test("offline the text stays writable, Send waits, and the head says the text is saved here", async () => {
    await mount();
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    window.dispatchEvent(new Event("offline"));
    await waitFor(() => status() === "Offline · saved here");
    expect(sendButton()!.disabled).toBe(true);
    expect(dom.root.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe("true");
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
    window.dispatchEvent(new Event("online"));
    await waitFor(() => !sendButton()!.disabled);
  });

  test("an upload fills a bar on its attachment, holds Send, and names its progress in the head", async () => {
    const files = await import("@k2b/cloud/browser/files");
    const choose = spyOn(files, "chooseFiles").mockResolvedValue([new File(["x".repeat(100)], "Skizze.pdf", { type: "application/pdf" })]);
    const rest = Promise.withResolvers<Response>();
    const serve = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost"), init);
        const url = new URL(request.url);
        if (url.pathname.endsWith("/attachment-uploads") && request.method === "POST")
          return Response.json({ id: "Upl001", chunkSize: 62 });
        // The first part arrives; the rest waits, so the upload stays at 62 %.
        if (url.pathname.endsWith("/attachment-uploads/Upl001") && request.method === "PATCH")
          return url.searchParams.get("offset") === "0" ? new Response(null, { status: 204 }) : rest.promise;
        return serve(input, init);
      },
      { preconnect: originalFetch.preconnect },
    );
    try {
      await mount();
      dom.root.querySelector<HTMLButtonElement>('button[aria-label="Attach files"]')!.click();
      await waitFor(() => status() === "Uploading · 62 %");
      expect(sendButton()!.disabled).toBe(true);
      const bar = dom.root.querySelector("[data-mail-upload] [role=progressbar]");
      expect(bar?.getAttribute("aria-valuenow")).toBe("62");
      expect(dom.root.querySelector("[data-mail-upload]")?.textContent).toContain("Uploading · 62 %");
    } finally {
      rest.resolve(Response.json({ code: "ABORTED", message: "Stopped" }, { status: 500 }));
      choose.mockRestore();
    }
  });

  test("on a phone sheet Send stands in the window's head and the bottom bar has none", async () => {
    await mount({ sheet: true });
    expect(actionsSlot.querySelector(".mail-compose-action")).not.toBeNull();
    expect(foot().querySelector(".mail-compose-action")).toBeNull();
    setSheet(false);
    await waitFor(() => foot().querySelector(".mail-compose-action") !== null);
    expect(actionsSlot.querySelector(".mail-compose-action")).toBeNull();
  });

  test("someone writing along shows with their initials and name", async () => {
    const offline = await import("@k2b/cloud/browser/shared-text");
    const generations = spyOn(offline, "listSharedTextOfflineGenerations").mockResolvedValue([]);
    const base = draftEditableContentInputSchema.strip().parse(initialDraft);
    const document = createDraftDocument(base);
    const bytes = Y.encodeStateAsUpdate(document);
    const cursor = "s6t.fixture.1";
    documentResponse = (path) =>
      path.endsWith("/document")
        ? Response.json({
            generation: "1",
            revision: 1,
            lifecycle: "draft",
            historyComplete: true,
            fresh: { state: encoding.toBase64(bytes), cursor, content: base },
            durable: { state: encoding.toBase64(bytes), cursor, content: base },
            frozen: null,
          })
        : null;
    localStorage.setItem("cloud:mail:shared:Usr001:Draft1:1:remember", "no");
    const peer = new Awareness(document);
    try {
      await mount({ draft: { ...initialDraft, editMode: "shared", generation: "1" }, ready: false });
      await waitFor(() =>
        OfflineWebSocket.instances.some((socket) => socket.url && new URL(socket.url).pathname.endsWith("/document/socket")),
      );
      const socket = OfflineWebSocket.instances.find((socket) => socket.url && new URL(socket.url).pathname.endsWith("/document/socket"))!;
      socket.open();
      socket.message({ type: "replayReady", payload: { docId: "Draft1", generation: "1", cursor, peerId: "peer1" } });
      const position = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(document.getText(DRAFT_BODY), 4));
      peer.setLocalState({ user: { name: "Tom Berg", color: "#2f6fb2" }, cursor: { head: position, anchor: position } });
      socket.message({
        type: "awarenessPush",
        payload: {
          docId: "Draft1",
          generation: "1",
          updates: [
            { generation: "1", payload: encoding.toBase64(encodeAwarenessUpdate(peer, [document.clientID])), originPeerId: "peer2" },
          ],
        },
      });
      await waitFor(() => dom.root.querySelector("[data-mail-draft-peers]")?.textContent?.includes("Tom Berg is writing too") === true);
      expect(dom.root.querySelector(".mail-inline-draft-peer")?.textContent).toBe("TB");
    } finally {
      peer.destroy();
      generations.mockRestore();
      document.destroy();
    }
  });
});
