import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EditorView } from "@codemirror/view";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../ui/test/dom";
import type { ConversationDraftSummary, MailDraft, SenderIdentity } from "../../contracts";
import type { MessageDetail } from "../../service/messages";
import type { MailReplyBoxApi } from "./MailReplyBox";

// The reply box with the real composer, draft session, and editor: what the mocked box suite cannot see.
const now = "2026-11-12T10:00:00.000Z";
const message = {
  id: "Msg001",
  subject: "Workbench",
  messageId: "<workbench@example.test>",
  internalDate: now,
  sentAt: now,
  from: [{ name: "Mara Lindqvist", address: "mara@example.test" }],
  to: [{ name: null, address: "shop@example.test" }],
  replyTo: [],
  cc: [],
  attachments: [],
  delivery: null,
} as unknown as MessageDetail;
const pendingSend = {
  ...message,
  id: "Msg002",
  from: [{ name: "Shop", address: "shop@example.test" }],
  delivery: {
    submissionId: "Sub001",
    draftId: "Draft1",
    state: "undo_window",
    attempt: 0,
    maxAttempts: 5,
    scheduledAt: now,
    undoUntil: "2026-11-12T10:00:18.000Z",
    acceptedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    acceptedRecipients: [],
    rejectedRecipients: [],
  },
} as unknown as MessageDetail;
const identity = {
  id: "Send01",
  mailboxId: "Box001",
  label: "Shop",
  displayName: "Shop",
  fromAddress: "shop@example.test",
  isDefault: true,
  status: "verified",
  transport: { capabilities: { dsn: false } },
} as unknown as SenderIdentity;
const content = {
  senderIdentityId: "Send01",
  signatureTemplateId: null,
  quoteSource: null,
  to: [{ name: "Mara Lindqvist", address: "mara@example.test" }],
  cc: [],
  bcc: [],
  subject: "Re: Workbench",
  body: "",
  format: "markdown",
  priority: "normal",
  requestDeliveryReceipt: false,
  requestReadReceipt: false,
} as const;
const draft = (overrides: Partial<MailDraft> = {}): MailDraft =>
  ({
    ...content,
    id: "Draft1",
    mailboxId: "Box001",
    conversationId: "Conv01",
    intent: "reply",
    sourceMessageId: "Msg001",
    derivedFromMessageId: null,
    derivationKind: null,
    body: "Reply text",
    attachments: [],
    suggestion: false,
    suggestedBy: null,
    createdBy: { kind: "user", userId: "Usr001" },
    lastEditedBy: { kind: "user", userId: "Usr001" },
    lastEditedByDisplayName: "Ada",
    recoveryCopyCount: 0,
    revision: 3,
    state: "draft",
    deliveryClass: "normal",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }) as MailDraft;
const summary: ConversationDraftSummary = {
  id: "Draft1",
  intent: "reply",
  subject: "Re: Workbench",
  updatedAt: now,
  suggestion: false,
  bodyPreview: "Reply text",
  createdByDisplayName: "Ada",
};

class OfflineWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = 0;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  send(_data: string) {}
  close() {
    this.readyState = 3;
  }
}

const waitFor = async (condition: () => boolean) => {
  // Bounded by the test's own timeout.
  while (!condition()) await Bun.sleep(5);
};

describe("MailReplyBox with the real composer", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  let dom: DomTestHarness;
  let dispose = () => {};
  let requests: Array<{ method: string; path: string; body: Record<string, unknown> | null }>;
  let intentConflict = false;
  let mailbox = 100;

  beforeEach(() => {
    dom = createDomTestHarness();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: OfflineWebSocket });
    const matches = HTMLElement.prototype.matches;
    const open = new WeakSet<HTMLElement>();
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
    delegateEvents(["click", "keydown", "input"]);
    requests = [];
    intentConflict = false;
    mailbox += 1;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost"), init);
        const path = new URL(request.url).pathname;
        const raw = request.method === "GET" ? "" : await request.text();
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
        requests.push({ method: request.method, path, body });
        if (path.endsWith("/draft-seeds")) {
          const origin = body!.origin as { input: { intent: string; sourceMessageId: string; body: string } };
          return Response.json({
            id: crypto.randomUUID(),
            mailboxId: "Box001",
            conversationId: "Conv01",
            intent: origin.input.intent,
            sourceMessageId: origin.input.sourceMessageId,
            derivedFromMessageId: null,
            derivationKind: null,
            content: { ...content, body: origin.input.body },
            attachments: [],
            origin,
            createdAt: now,
          });
        }
        if (path.endsWith("/draft-seeds/materialize")) {
          const origin = body!.origin as { input: { intent: MailDraft["intent"] } };
          return Response.json({
            ...draft({ id: "DraftN", intent: origin.input.intent, revision: 1 }),
            ...(body!.draft as object),
            creationOutcome: "created",
          });
        }
        if (path.endsWith("/lease") && request.method === "GET") return Response.json(null);
        if (path.endsWith("/lease"))
          return Response.json({
            token: crypto.randomUUID(),
            holder: { kind: "user", id: "Usr001", displayName: "Ada", avatarHash: null },
            acquiredAt: now,
            expiresAt: now,
          });
        if (path.endsWith("/intent"))
          return intentConflict
            ? Response.json({ code: "CONFLICT", message: "Someone else changed the draft." }, { status: 409 })
            : Response.json(draft({ intent: (body as { intent: MailDraft["intent"] }).intent, revision: 4 }));
        if (/\/drafts\/Draft\w+$/.test(path) && request.method === "PUT")
          return Response.json({ ...draft(), ...(body!.draft as object), revision: 4 });
        if (/\/drafts\/Draft\w+$/.test(path)) return Response.json(draft());
        if (path.endsWith("/compose-signature")) return Response.json({ html: null, text: "" });
        if (path.endsWith("/compose-preview")) return Response.json({ html: "", text: "", formattingWarnings: [] });
        return Response.json([]);
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

  const mount = async (options: { drafts?: ConversationDraftSummary[]; messages?: MessageDetail[] } = {}) => {
    const [{ default: MailReplyBox }, { LocaleProvider }] = await Promise.all([import("./MailReplyBox"), import("@k2b/ui")]);
    let api: MailReplyBoxApi | undefined;
    dispose = render(
      () => (
        <LocaleProvider locale="en">
          <MailReplyBox
            mailboxId={`Box${mailbox}`}
            conversationId="Conv01"
            subject="Workbench"
            messages={options.messages ?? [message]}
            conversationDrafts={options.drafts ?? []}
            identities={[identity]}
            canReplyAll={true}
            customerName="Mara Lindqvist"
            currentUserId="Usr001"
            currentUserEmail={null}
            dateConfig={{ locale: "en", timeZone: "UTC" }}
            canAdmin={false}
            mailboxRecipientSuggestions={false}
            calendarIntegrationAvailable={false}
            liveDictation={false}
            returnHref="/app/mail/Box001"
            messageLabel={() => null}
            createNote={async () => {
              throw new Error("not used");
            }}
            onReconcile={async () => undefined}
            onExplainSenderUnavailable={() => undefined}
            register={(next) => {
              api = next;
            }}
          />
        </LocaleProvider>
      ),
      dom.root,
    );
    await waitFor(() => Boolean(dom.root.querySelector("[data-mail-reply-box='mail'] .cm-content")));
    return { api: () => api! };
  };
  const remount = async (options: Parameters<typeof mount>[0] = {}) => {
    dispose();
    dispose = () => {};
    dom.root.textContent = "";
    return mount(options);
  };
  const view = () => EditorView.findFromDOM(dom.root.querySelector<HTMLElement>("[data-mail-reply-box='mail'] .cm-editor")!)!;
  /** The box's text, or "" while its editor is (re)mounting. */
  const boxText = () => {
    const editor = dom.root.querySelector<HTMLElement>("[data-mail-reply-box='mail'] .cm-editor");
    return editor ? (EditorView.findFromDOM(editor)?.state.doc.toString() ?? "") : "";
  };
  const type = (text: string) => view().dispatch({ changes: { from: view().state.doc.length, insert: text }, userEvent: "input.type" });
  const chooseMode = async (label: string) => {
    dom.root.querySelector<HTMLButtonElement>("[data-mail-reply-mode]")!.click();
    await waitFor(() =>
      Array.from(dom.document.querySelectorAll('[role="menuitemradio"]')).some((item) => item.textContent?.includes(label)),
    );
    Array.from(dom.document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))
      .find((item) => item.textContent?.includes(label))!
      .click();
  };
  const materialized = () => requests.filter((request) => request.path.endsWith("/draft-seeds/materialize"));

  test("a mode switch before the first save carries the text into one draft in the new mode", async () => {
    await mount();
    type("Typed right away");
    await chooseMode("Forward");
    await waitFor(() => boxText().includes("Typed right away") && materialized().length > 0);
    // fixed wait: longer than another autosave round, so a second draft would have shown.
    await Bun.sleep(1_000);
    expect(materialized()).toHaveLength(1);
    const created = materialized()[0]!.body as { origin: { input: { intent: string } }; draft: { body: string } };
    expect(created.origin.input.intent).toBe("forward");
    expect(created.draft.body).toContain("Typed right away");
  });

  test("text typed during the undo window comes back after leaving and reopening the conversation", async () => {
    await mount({ messages: [message, pendingSend] });
    type("Written while the last reply waited");
    // fixed wait: the held place keeps the text local; no autosave may create a draft.
    await Bun.sleep(900);
    expect(materialized()).toHaveLength(0);
    await remount({ messages: [message, pendingSend] });
    await waitFor(() => boxText().includes("Written while the last reply waited"));
    expect(materialized()).toHaveLength(0);
  });

  test("after Undo, the text typed meanwhile stays offered to restore across leaving and reopening", async () => {
    const { api } = await mount({ messages: [message, pendingSend] });
    type("Meanwhile text");
    api().openDraft("Draft1");
    await waitFor(() => Boolean(dom.root.querySelector("[data-mail-reply-meanwhile]")));
    await remount({ drafts: [summary] });
    await waitFor(() => Boolean(dom.root.querySelector("[data-mail-reply-meanwhile]")));
    expect(dom.root.querySelector("[data-mail-reply-meanwhile]")!.textContent).toContain("Meanwhile text");
    Array.from(dom.root.querySelectorAll<HTMLButtonElement>("[data-mail-reply-meanwhile] button"))
      .find((button) => button.textContent === "Restore changes")!
      .click();
    await waitFor(() => boxText().includes("Meanwhile text"));
    await remount({ drafts: [summary] });
    expect(dom.root.querySelector("[data-mail-reply-meanwhile]")).toBeNull();
  });

  test("a failed mode switch keeps the mode on display that the draft has, and says why quietly", async () => {
    intentConflict = true;
    await mount({ drafts: [summary] });
    await chooseMode("Forward");
    await waitFor(() => Boolean(dom.root.querySelector("[data-mail-reply-switch-failed]")));
    await waitFor(() => Boolean(dom.root.querySelector("[data-mail-reply-box='mail'] .cm-content")));
    expect(dom.root.querySelector("[data-mail-reply-mode]")!.getAttribute("data-mail-reply-mode")).toBe("reply");
    expect(dom.root.querySelector("[data-mail-reply-box='mail']")!.getAttribute("data-intent")).toBe("reply");
    expect(dom.root.querySelector("[data-mail-reply-switch-failed]")!.textContent).toContain("Someone else changed the draft.");
    expect(dom.document.querySelector('[role="alertdialog"], dialog[open]')).toBeNull();
  });

  test("local note text belongs to the signed-in person", async () => {
    await mount();
    await chooseMode("Internal note");
    await waitFor(() => Boolean(dom.root.querySelector("[data-mail-reply-box='note'] textarea")));
    const field = dom.root.querySelector<HTMLTextAreaElement>("[data-mail-reply-box='note'] textarea")!;
    field.value = "Half a thought";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    const keys = Array.from({ length: dom.window.localStorage.length }, (_, index) => dom.window.localStorage.key(index) ?? "");
    const stored = keys.filter((key) => dom.window.localStorage.getItem(key) === "Half a thought");
    expect(stored).toHaveLength(1);
    expect(stored[0]!.startsWith("cloud:user:Usr001:")).toBe(true);
    expect(dom.window.sessionStorage.length).toBe(0);
  });
});
