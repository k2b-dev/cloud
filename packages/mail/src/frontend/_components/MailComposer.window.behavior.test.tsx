import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { encoding } from "@k2b/stdlib";
import type { PanesLayout } from "@k2b/ui";
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
  let documentResponse: ((path: string) => Response | Promise<Response> | null) | null;

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

  const mount = async (
    options: {
      draft?: MailDraft;
      uploads?: UnfinishedDraftUpload[];
      sheet?: boolean;
      ready?: boolean;
      fullscreen?: () => boolean;
      initialSelection?: { anchor: number; head: number };
      panes?: PanesLayout;
      identities?: SenderIdentity[];
    } = {},
  ) => {
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
            identities={options.identities ?? [identity]}
            signatures={{ templates: [], personalDefaults: [] }}
            initialDraft={options.draft ?? initialDraft}
            unfinishedUploads={options.uploads}
            initialPanes={options.panes ?? { version: 2, root: { type: "group", items: ["editor", "preview"], active: "editor" } }}
            returnHref="/app/mail/Box001"
            dateConfig={{ locale: "en", timeZone: "UTC" }}
            host={{
              fresh: false,
              fullscreen: options.fullscreen ?? (() => false),
              toggleFullscreen: () => undefined,
              initialSelection: options.initialSelection,
              register: () => undefined,
              messageSource: () => null,
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
  const status = () => statusSlot.querySelector(".mail-compose-window-status")?.textContent?.trim() ?? "";
  const foot = () => dom.root.querySelector<HTMLElement>(".mail-compose-window-foot")!;

  test("the window's head carries the save status; the bar starts with Send and ends with the trash", async () => {
    await mount();
    await waitFor(() => status() === "Saved");
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

  test("the sender leads the window's head with a chevron to change it; the subject row starts with Subject", async () => {
    const info: SenderIdentity = {
      ...identity,
      id: "Send02",
      label: "Info",
      displayName: "Info",
      fromAddress: "info@example.test",
      isDefault: false,
    };
    await mount({ identities: [identity, info] });
    await waitFor(() => status() === "Saved");
    const trigger = statusSlot.querySelector<HTMLButtonElement>("[data-mail-compose-sender] button");
    expect(trigger?.getAttribute("aria-label")).toBe("Change sender identity. Current sender: Support, support@example.test");
    expect(trigger?.textContent).toBe("fromSupport");
    expect(trigger?.querySelector(".ti-chevron-down")).not.toBeNull();
    // The sender stands before the save state, and nowhere in the draft itself.
    const sender = statusSlot.querySelector("[data-mail-compose-sender]")!;
    expect(sender.compareDocumentPosition(statusSlot.querySelector(".mail-compose-window-status")!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(dom.root.querySelector('button[aria-label^="Change sender identity"]')).toBeNull();
    const row = dom.root.querySelector<HTMLElement>(".mail-inline-draft-meta")!;
    expect(row.textContent?.trim().startsWith("Subject")).toBe(true);
    // To and Subject form one block that stays in view above the text.
    expect(row.parentElement?.matches("[data-mail-draft-fields]")).toBe(true);
    expect(dom.root.querySelector("[data-mail-draft-fields] > .mail-inline-draft-head")).not.toBeNull();
  });

  test("a reply's original stands under the signature as a card: it loads in place, fails with a way out, and × leaves it out", async () => {
    const original = {
      from: [{ name: "Lena Berger", address: "lena@example.test" }],
      internalDate: now,
      plainText:
        "Hello,\n\ncould we move the pickup to Saturday at 11? The van only fits twelve chairs.\nIf hall A is still locked, call me at the gate.\n\nThanks, Lena",
    };
    let answer = Promise.withResolvers<Response>();
    documentResponse = (path) => (path.endsWith("/messages/Msg001") ? answer.promise : null);
    await mount({
      draft: {
        ...initialDraft,
        intent: "reply",
        conversationId: "Conv01",
        sourceMessageId: "Msg001",
        quoteSource: { locale: "en", timeZone: "UTC" },
      },
    });
    const card = () => dom.root.querySelector<HTMLElement>("[data-mail-quote-card]");
    // Loading holds the collapsed card's place under the signature.
    expect(card()?.hasAttribute("data-loading")).toBe(true);
    const signature = dom.root.querySelector(".mail-inline-draft-signature, [data-mail-draft-signature]");
    if (signature) expect(signature.compareDocumentPosition(card()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    answer.resolve(Response.json({ message: "Unavailable" }, { status: 503 }));
    await waitFor(() => card()?.hasAttribute("data-failed") === true);
    expect(card()!.getAttribute("role")).toBe("alert");
    expect(card()!.textContent).toContain("It still goes along below your signature.");
    answer = Promise.withResolvers<Response>();
    answer.resolve(Response.json(original));
    [...card()!.querySelectorAll("button")].find((button) => button.textContent === "Try again")!.click();
    await waitFor(() => card()?.getAttribute("aria-label") === "Original message from Lena Berger");
    // Collapsed: the first two lines with content, not the greeting.
    expect([...card()!.querySelectorAll(".mail-quote-card-text > p")].map((line) => line.textContent)).toEqual([
      "could we move the pickup to Saturday at 11? The van only fits twelve chairs.",
      "If hall A is still locked, call me at the gate.",
    ]);
    [...card()!.querySelectorAll("button")].find((button) => button.textContent === "Show all")!.click();
    await waitFor(() => card()!.querySelectorAll(".mail-quote-card-text > p").length === 3);
    card()!.querySelector<HTMLButtonElement>('button[aria-label="Leave the original message out"]')!.click();
    const add = () => dom.root.querySelector<HTMLButtonElement>("[data-mail-quote-add]");
    await waitFor(() => Boolean(add()));
    expect(card()).toBeNull();
    // The focus follows to the control that takes the place, never to the page.
    await waitFor(() => dom.document.activeElement === add());
    add()!.click();
    await waitFor(() => Boolean(card()));
    await waitFor(() => dom.document.activeElement === card()!.querySelector('button[aria-label="Leave the original message out"]'));
  });

  test("an original that is gone or not visible here shows no card, as nothing goes along", async () => {
    documentResponse = (path) => (path.endsWith("/messages/Msg001") ? Response.json({ message: "Not found" }, { status: 404 }) : null);
    await mount({
      draft: {
        ...initialDraft,
        intent: "reply",
        conversationId: "Conv01",
        sourceMessageId: "Msg001",
        quoteSource: { locale: "en", timeZone: "UTC" },
      },
    });
    await waitFor(() => !dom.root.querySelector("[data-mail-quote-card][data-loading]"));
    expect(dom.root.querySelector("[data-mail-quote-card]")).toBeNull();
  });

  test("a message without text adds no quote and shows no card", async () => {
    documentResponse = (path) =>
      path.endsWith("/messages/Msg001")
        ? Response.json({
            from: [{ name: "Lena Berger", address: "lena@example.test" }],
            internalDate: now,
            plainText: null,
            forwardText: "",
          })
        : null;
    await mount({
      draft: {
        ...initialDraft,
        intent: "reply",
        conversationId: "Conv01",
        sourceMessageId: "Msg001",
        quoteSource: { locale: "en", timeZone: "UTC" },
      },
    });
    await waitFor(() => !dom.root.querySelector("[data-mail-quote-card][data-loading]"));
    expect(dom.root.querySelector("[data-mail-quote-card]")).toBeNull();
    expect(dom.root.querySelector("[data-mail-quote-add]")).toBeNull();
  });

  test("a send that fails keeps the window with its text; a toast names the reason and Send stays in place", async () => {
    await mount();
    commandFailure = "The mail server is not reachable.";
    sendButton()!.click();
    // Send keeps its label and place, so the bar does not move; it repeats the send.
    await waitFor(() => sendButton()!.closest("[data-mail-send-again]") !== null);
    expect(sendButton()!.textContent).toContain("Send");
    const toastCard = () => dom.document.querySelector<HTMLElement>("[data-k2b-toast-container] .k2b-toast");
    await waitFor(() => Boolean(toastCard()));
    expect(toastCard()!.querySelector(".k2b-toast__title")?.textContent).toBe("Not sent");
    expect(toastCard()!.querySelector(".k2b-toast__description")?.textContent).toBe(
      "The mail server is not reachable. Your text stays in the draft.",
    );
    // One place for the reason: the bar keeps its tools and shows no second copy of it.
    expect(foot().getAttribute("data-tone")).toBeNull();
    expect(foot().textContent).not.toContain("not reachable");
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

  /**
   * A shared draft in the large window whose generation the server closes live while this composer's send command
   * runs, so the close always arrives before the command's answer. Returns what the composer showed meanwhile.
   */
  const sendSharedClosedLive = async (options: {
    /** `failedFirst`: the command answers with an error, and the close arrives after that answer. */
    command?: "ok" | "lost" | "failedFirst";
    closedBy?: "me" | "peer";
    rest?: "unchanged" | "failed";
    typeDuringSend?: boolean;
  }) => {
    const offline = await import("@k2b/cloud/browser/shared-text");
    const { EditorView } = await import("@codemirror/view");
    const generations = spyOn(offline, "listSharedTextOfflineGenerations").mockResolvedValue([]);
    const base = draftEditableContentInputSchema.strip().parse(initialDraft);
    const document = createDraftDocument(base);
    const state = encoding.toBase64(Y.encodeStateAsUpdate(document));
    const cursor = "s6t.fixture.1";
    const snapshot = { state, cursor, content: base };
    const editor =
      options.closedBy === "peer"
        ? { lastEditedBy: { kind: "user" as const, userId: "Usr002" }, lastEditedByDisplayName: "Tom" }
        : { lastEditedBy: { kind: "user" as const, userId: "Usr001" }, lastEditedByDisplayName: "Ada" };
    let sent = false;
    documentResponse = (path) => {
      if (path.endsWith("/document"))
        return Response.json({
          generation: "1",
          revision: 1,
          lifecycle: sent ? "sending" : "draft",
          historyComplete: true,
          fresh: snapshot,
          durable: snapshot,
          frozen: sent ? { state, cursor, generation: "1", revision: 1 } : null,
        });
      if (path.endsWith("/document/snapshot")) return Response.json({ generation: "1", status: "saved", revision: 1, durable: snapshot });
      if (path.endsWith("/document/rest"))
        return options.rest === "failed"
          ? Response.json({ message: "The comparison is not available." }, { status: 503 })
          : Response.json({ status: "unchanged", durableSourceState: state });
      if (path.endsWith("/drafts/Draft1"))
        return Response.json({ ...initialDraft, ...editor, editMode: "shared", generation: "1", state: sent ? "sending" : "draft" });
      return null;
    };
    const serve = globalThis.fetch;
    let socket!: OfflineWebSocket;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost"), init);
        if (!new URL(request.url).pathname.endsWith("/commands")) return serve(input, init);
        // Typed after Send: real input the sent message does not hold.
        if (options.typeDuringSend) {
          const view = EditorView.findFromDOM(dom.root.querySelector<HTMLElement>(".cm-editor")!)!;
          view.dispatch({ changes: { from: view.state.doc.length, insert: " P.S. Bring the invoice." }, userEvent: "input.type" });
        }
        const close = () =>
          socket.message({ type: "error", payload: { code: "GENERATION_CLOSED", message: "Draft sent", docId: "Draft1", reopen: true } });
        sent = true;
        if (options.command === "failedFirst") {
          setTimeout(close, 40);
          return Response.json({ code: "SEND_FAILED", message: "The connection broke." }, { status: 503 });
        }
        // The server closes the draft's generation and tells every open copy before the command answers.
        close();
        await Bun.sleep(60);
        if (options.command === "lost" || options.closedBy === "peer") throw new TypeError("Failed to fetch");
        return serve(input, init);
      },
      { preconnect: serve.preconnect },
    );
    localStorage.setItem("cloud:mail:shared:Usr001:Draft1:1:remember", "no");
    const seen = new Set<string>();
    const visible = () =>
      [...dom.document.querySelectorAll(".mail-inline-draft-notice, .mail-draft-hint[data-tone], .k2b-notice-card")]
        .filter((element) => !element.closest("[hidden]"))
        .map((element) => element.textContent?.trim() ?? "");
    const observer = new MutationObserver(() => {
      for (const text of visible()) seen.add(text);
    });
    try {
      await mount({ draft: { ...initialDraft, editMode: "shared", generation: "1" }, ready: false, fullscreen: () => true });
      await waitFor(() =>
        OfflineWebSocket.instances.some((candidate) => candidate.url && new URL(candidate.url).pathname.endsWith("/document/socket")),
      );
      socket = OfflineWebSocket.instances.find(
        (candidate) => candidate.url && new URL(candidate.url).pathname.endsWith("/document/socket"),
      )!;
      socket.open();
      socket.message({ type: "replayReady", payload: { docId: "Draft1", generation: "1", cursor, peerId: "peer1" } });
      await waitFor(() => Boolean(sendButton() && !sendButton()!.disabled));
      observer.observe(dom.document.body, { childList: true, subtree: true, characterData: true });
      sendButton()!.click();
      await waitFor(() => leaves.length > 0 || (options.rest === "failed" && visible().length > 0));
      await Bun.sleep(150);
      // A dismissed toast leaves with its exit motion; only toasts still standing count.
      const toasts = [...dom.document.querySelectorAll<HTMLElement>(".k2b-toast")]
        .filter((toast) => !toast.closest("[data-closing]"))
        .map((toast) => toast.textContent?.trim() ?? "");
      return { seen: [...seen], now: visible(), toasts };
    } finally {
      observer.disconnect();
      generations.mockRestore();
      document.destroy();
    }
  };
  const commands = () => requests.filter((request) => request === "POST /api/mail/mailboxes/Box001/commands");

  test("a shared draft sent from the large window closes once with one toast, also when its own send arrives first live", async () => {
    const shown = await sendSharedClosedLive({});
    expect(leaves).toEqual(["sent"]);
    expect(delivered).toEqual([{ submissionId: "Dlv001", scheduledAt: null, undoSeconds: expect.any(Number) }]);
    // No notice, hint or lifecycle box, not even for a frame, and no toast that someone started sending.
    expect(shown.seen).toEqual([]);
    expect(shown.toasts.join(" ")).not.toContain("started sending");
    expect(commands()).toHaveLength(1);
  });

  test("an own send whose answer got lost after the live close leaves with the delivery toast, without Undo", async () => {
    const shown = await sendSharedClosedLive({ command: "lost" });
    expect(leaves).toEqual(["sent"]);
    expect(delivered).toEqual([{ submissionId: null, scheduledAt: null, undoSeconds: expect.any(Number) }]);
    expect(shown.seen).toEqual([]);
    expect(shown.toasts.join(" ")).not.toContain("started sending");
    expect(shown.toasts.join(" ")).not.toContain("Not sent");
  });

  test("an own send whose error answer came before the live close leaves with the delivery toast too", async () => {
    const shown = await sendSharedClosedLive({ command: "failedFirst" });
    expect(leaves).toEqual(["sent"]);
    expect(delivered).toEqual([{ submissionId: null, scheduledAt: null, undoSeconds: expect.any(Number) }]);
    expect(shown.toasts.join(" ")).not.toContain("started sending");
    expect(shown.toasts.join(" ")).not.toContain("Not sent");
  });

  test("when someone else sent first, the failed own send shows no failure; the lifecycle says who sent", async () => {
    const shown = await sendSharedClosedLive({ closedBy: "peer" });
    expect(delivered).toEqual([]);
    expect(leaves).toEqual(["sent"]);
    expect(shown.toasts.join(" ")).toContain("Tom started sending this message.");
    expect(shown.toasts.join(" ")).not.toContain("Not sent");
  });

  test("input typed during the send stays visible with its rescue when the comparison with the sent draft fails", async () => {
    const shown = await sendSharedClosedLive({ typeDuringSend: true, rest: "failed" });
    expect(leaves).toEqual([]);
    // The failure names itself with Try again and Copy; nothing hides that the input is not safe yet.
    expect(shown.now.join(" ")).toContain("The comparison is not available.");
    expect(dom.root.querySelector(".mail-draft-hint-slot")?.hasAttribute("hidden")).toBe(false);
  });

  test("Write large moves the same draft into panes beside the preview and back, keeping its text and caret", async () => {
    const previews: string[] = [];
    documentResponse = (path) => {
      if (!path.endsWith("/compose-preview")) return null;
      previews.push(path);
      return Response.json({ html: "<p>Good morning</p>", text: "Good morning", formattingWarnings: [] });
    };
    const [large, setLarge] = createSignal(true);
    // Mail's own start: the draft beside the preview (a new message has no conversation).
    const { createDefaultMailComposerPanesLayout } = await import("./mail-composer-panes");
    await mount({ fullscreen: large, initialSelection: { anchor: 5, head: 12 }, panes: createDefaultMailComposerPanesLayout() });
    const text = dom.root.querySelector<HTMLElement>(".cm-content")!;
    const block = dom.root.querySelector<HTMLElement>("[data-mail-draft-block]")!;
    const view = (text as HTMLElement & { cmView?: { view: { state: { selection: { main: { anchor: number; head: number } } } } } }).cmView
      ?.view;
    // The caret the box had stands in the text, and the text has the focus.
    if (view) expect([view.state.selection.main.anchor, view.state.selection.main.head]).toEqual([5, 12]);
    await waitFor(() => dom.document.activeElement === text);

    // A new message: the draft beside the preview, no conversation; the preview follows the typing.
    const panes = dom.root.querySelector<HTMLElement>(".mail-large-panes")!;
    expect(panes.contains(block)).toBe(true);
    expect([...panes.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim())).toEqual(["Draft", "Preview"]);
    await waitFor(() => previews.length > 0 && Boolean(panes.querySelector(".mail-large-preview iframe")));
    expect(panes.querySelector(".mail-large-preview-status")?.textContent).toContain("As the mail arrives");
    // The window's own preview switch would duplicate the pane.
    expect(dom.root.querySelector("[data-mail-draft-preview]")).toBeNull();

    // Smaller: the very same draft element goes back into the window; the text and its focus stay.
    setLarge(false);
    await waitFor(() => !dom.root.querySelector(".mail-large-panes"));
    expect(dom.root.querySelector("[data-mail-draft-block]")).toBe(block);
    expect(dom.root.querySelector(".cm-content")).toBe(text);
    expect(text.textContent).toContain("Good morning");
    await waitFor(() => dom.document.activeElement === text);
  });

  test("on a phone sheet the large draft shows Draft, Preview, History in the mockup's order and keeps the stored layout", async () => {
    documentResponse = (path) => {
      if (path.endsWith("/compose-preview"))
        return Response.json({ html: "<p>Good morning</p>", text: "Good morning", formattingWarnings: [] });
      if (path.includes("/conversations/Conv01/")) return Response.json({ items: [], nextCursor: null });
      return null;
    };
    const { createDefaultMailComposerPanesLayout } = await import("./mail-composer-panes");
    await mount({
      fullscreen: () => true,
      sheet: true,
      panes: createDefaultMailComposerPanesLayout(),
      draft: { ...initialDraft, intent: "reply", conversationId: "Conv01" },
    });
    const panes = dom.root.querySelector<HTMLElement>(".mail-large-panes")!;
    expect([...panes.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim())).toEqual(["Draft", "Preview", "History"]);
    expect(panes.querySelectorAll(".k2b-panes__group")).toHaveLength(1);
    expect(dom.document.cookie).not.toContain("settings-app-mail-composer-panes");
  });

  // Lesson 2026-11-14: the large preview of a plain-text message stood still while the person typed.
  test("written large, the preview of a plain-text message follows the typing", async () => {
    const { EditorView } = await import("@codemirror/view");
    const previews: string[] = [];
    const serve = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost"), init);
        if (new URL(request.url).pathname.endsWith("/compose-preview")) {
          const body = (await request.clone().json()) as { draft: { body: string } };
          previews.push(body.draft.body);
          return Response.json({ html: `<pre>${body.draft.body}</pre>`, text: body.draft.body, formattingWarnings: [] });
        }
        return serve(input, init);
      },
      { preconnect: originalFetch.preconnect },
    );
    const { createDefaultMailComposerPanesLayout } = await import("./mail-composer-panes");
    await mount({ fullscreen: () => true, panes: createDefaultMailComposerPanesLayout(), draft: { ...initialDraft, format: "plain" } });
    // The stored arrangement stands as it is: the preview beside the draft, not a tab behind it.
    expect(dom.root.querySelectorAll(".mail-large-panes .k2b-panes__group")).toHaveLength(2);
    await waitFor(() => previews.length > 0);
    expect(previews.at(-1)).toBe("Good morning");

    const view = EditorView.findFromDOM(dom.root.querySelector<HTMLElement>(".cm-editor")!)!;
    view.dispatch({ changes: { from: view.state.doc.length, insert: ", Mara" }, userEvent: "input.type" });
    await waitFor(() => previews.at(-1) === "Good morning, Mara");
    expect(dom.root.querySelector(".mail-large-preview-status")?.textContent).toContain("follows your typing");
  });
});
