import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EditorView } from "@codemirror/view";
import { createSignal } from "solid-js";
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
  /** The next `/draft-seeds` requests that fail, after the first one. */
  let seedFailures = 0;
  /** Holds the materialize answer back until the test lets it go. */
  let materializeGate: Promise<void> | null = null;
  /** The reply draft a materialization created; a later one meets it as the occupied reply place. */
  let createdDraftId: string | null = null;
  /** What the server holds per draft after a materialization or a save. */
  let saved: Record<string, Partial<MailDraft>> = {};
  /** Answers a request before the default server does; null leaves it to the default. */
  let intercept: ((entry: { method: string; path: string; body: Record<string, unknown> | null }) => Promise<Response | null>) | null =
    null;
  let reconcile: (() => Promise<void>) | null = null;
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
    seedFailures = 0;
    materializeGate = null;
    createdDraftId = null;
    saved = {};
    intercept = null;
    reconcile = null;
    mailbox += 1;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost"), init);
        const path = new URL(request.url).pathname;
        const raw = request.method === "GET" ? "" : await request.text();
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
        requests.push({ method: request.method, path, body });
        const injected = await intercept?.({ method: request.method, path, body });
        if (injected) return injected;
        if (path.endsWith("/draft-seeds") && seedFailures > 0 && requests.filter((entry) => entry.path === path).length > 1) {
          seedFailures -= 1;
          return Response.json({ code: "UNAVAILABLE", message: "The server is busy." }, { status: 503 });
        }
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
          if (materializeGate) await materializeGate;
          const origin = body!.origin as { input: { intent: MailDraft["intent"] } };
          // The conversation has one reply place: a second materialization gets the draft that holds it.
          if (createdDraftId) return Response.json({ ...draft({ id: createdDraftId }), creationOutcome: "existing" });
          createdDraftId = "DraftN";
          saved.DraftN = { intent: origin.input.intent, ...(body!.draft as Partial<MailDraft>), revision: 1 };
          return Response.json({ ...draft({ id: "DraftN", ...saved.DraftN }), creationOutcome: "created" });
        }
        if (path.endsWith("/lease") && request.method === "GET") return Response.json(null);
        if (path.endsWith("/lease"))
          return Response.json({
            token: crypto.randomUUID(),
            holder: { kind: "user", id: "Usr001", displayName: "Ada", avatarHash: null },
            acquiredAt: now,
            expiresAt: now,
          });
        const draftPath = /\/drafts\/(Draft\w+)(?:\/\w+)?$/.exec(path);
        const id = draftPath?.[1] ?? "Draft1";
        if (path.endsWith("/intent")) {
          if (intentConflict) return Response.json({ code: "CONFLICT", message: "Someone else changed the draft." }, { status: 409 });
          saved[id] = { ...saved[id], intent: (body as { intent: MailDraft["intent"] }).intent, revision: 4 };
          return Response.json(draft({ ...saved[id], id }));
        }
        if (path.endsWith("/discard")) return Response.json(draft({ id, state: "discarded" } as Partial<MailDraft>));
        if (/\/drafts\/Draft\w+$/.test(path) && request.method === "PUT") {
          saved[id] = { ...saved[id], ...(body!.draft as Partial<MailDraft>), revision: 4 };
          return Response.json(draft({ ...saved[id], id }));
        }
        if (/\/drafts\/Draft\w+$/.test(path)) return Response.json(draft({ ...saved[id], id }));
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
            onReconcile={async () => {
              await reconcile?.();
            }}
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
  const modeOnDisplay = () => dom.root.querySelector("[data-mail-reply-mode]")?.getAttribute("data-mail-reply-mode") ?? null;
  const meanwhileLines = () => Array.from(dom.root.querySelectorAll("[data-mail-reply-meanwhile]"), (line) => line.textContent ?? "");
  /** Holds every materialize answer until the returned function lets them go. */
  const holdMaterialize = () => {
    let release = () => {};
    materializeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      materializeGate = null;
      release();
    };
  };

  test("a failed mode switch of an unsaved seed keeps its text and its mode, and the next try carries the text", async () => {
    await mount();
    type("Keep me");
    seedFailures = 1;
    await chooseMode("Forward");
    await waitFor(() => requests.filter((request) => request.path.endsWith("/draft-seeds")).length >= 2);
    // fixed wait: a reload of the box after the failure would have shown by now.
    await Bun.sleep(300);
    expect(boxText()).toContain("Keep me");
    expect(modeOnDisplay()).toBe("reply");
    expect(dom.root.querySelector("[data-mail-reply-switch-failed]")?.textContent).toContain("The server is busy.");
    await chooseMode("Forward");
    await waitFor(() => modeOnDisplay() === "forward" && boxText().includes("Keep me") && materialized().length > 0);
    const created = materialized()[0]!.body as { origin: { input: { intent: string } }; draft: { body: string } };
    expect(created.origin.input.intent).toBe("forward");
    expect(created.draft.body).toContain("Keep me");
  }, 15_000);

  test("a second Undo keeps the earlier text typed meanwhile as well, newest first, across reopening", async () => {
    const first = await mount({ messages: [message, pendingSend] });
    type("First meanwhile");
    first.api().openDraft("Draft1");
    await waitFor(() => meanwhileLines().length === 1);
    const second = await remount({ messages: [message, pendingSend] });
    type("Second meanwhile");
    second.api().openDraft("Draft1");
    await waitFor(() => meanwhileLines().some((line) => line.includes("Second meanwhile")));
    await remount({ drafts: [summary] });
    await waitFor(() => meanwhileLines().length > 0);
    expect(meanwhileLines()).toHaveLength(2);
    expect(meanwhileLines()[0]).toContain("Second meanwhile");
    expect(meanwhileLines()[1]).toContain("First meanwhile");
    Array.from(dom.root.querySelectorAll<HTMLButtonElement>("[data-mail-reply-meanwhile] button"))
      .find((button) => button.textContent === "Restore changes")!
      .click();
    await waitFor(() => boxText().includes("Second meanwhile"));
    expect(meanwhileLines()).toHaveLength(1);
    expect(meanwhileLines()[0]).toContain("First meanwhile");
  });

  test("a mode switch while the first save is on its way switches the draft it creates, with no second draft", async () => {
    await mount();
    const release = holdMaterialize();
    type("Racing the first save");
    await waitFor(() => materialized().length === 1);
    await chooseMode("Forward");
    // fixed wait: the switch waits for the first save instead of starting a seed of its own.
    await Bun.sleep(100);
    release();
    // fixed wait: longer than another autosave round, so a second materialization would have shown.
    await Bun.sleep(1_200);
    expect(materialized()).toHaveLength(1);
    const switched = requests.filter((request) => request.path.endsWith("/DraftN/intent"));
    expect(switched).toHaveLength(1);
    expect(switched[0]!.body).toMatchObject({ intent: "forward" });
    await waitFor(() => boxText().includes("Racing the first save"));
  }, 15_000);

  test("discarding while the first save is on its way discards the draft that save created", async () => {
    const { prompts } = await import("@k2b/ui");
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
    try {
      await mount();
      const release = holdMaterialize();
      type("Gone soon");
      await waitFor(() => materialized().length === 1);
      dom.root.querySelector<HTMLButtonElement>("[data-mail-reply-discard]")!.click();
      await waitFor(() => confirm.mock.calls.length === 1);
      release();
      // fixed wait: the discard settles after the first save's answer.
      await Bun.sleep(1_000);
      expect(requests.filter((request) => request.path.endsWith("/DraftN/discard"))).toHaveLength(1);
      expect(materialized()).toHaveLength(1);
    } finally {
      confirm.mockRestore();
    }
  }, 15_000);

  test("discarding while a first save meets a colleague's reply draft drops only the local text", async () => {
    const { prompts } = await import("@k2b/ui");
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
    try {
      createdDraftId = "DraftC";
      await mount();
      const release = holdMaterialize();
      type("Mine only");
      await waitFor(() => materialized().length === 1);
      dom.root.querySelector<HTMLButtonElement>("[data-mail-reply-discard]")!.click();
      await waitFor(() => confirm.mock.calls.length === 1);
      release();
      // fixed wait: the discard settles after the first save's answer.
      await Bun.sleep(500);
      expect(requests.some((request) => request.path.endsWith("/discard"))).toBe(false);
    } finally {
      confirm.mockRestore();
    }
  }, 15_000);

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

  test("after signing out, typing in a note still on screen recreates no local storage", async () => {
    await mount();
    await chooseMode("Internal note");
    await waitFor(() => Boolean(dom.root.querySelector("[data-mail-reply-box='note'] textarea")));
    const field = dom.root.querySelector<HTMLTextAreaElement>("[data-mail-reply-box='note'] textarea")!;
    field.value = "Before signing out";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    // Signing out fences the person's storage with a new epoch and clears their namespace (see browser/session.ts).
    const storage = dom.window.localStorage;
    storage.setItem("cloud:user-epoch:Usr001", crypto.randomUUID());
    for (const key of Array.from({ length: storage.length }, (_, index) => storage.key(index) ?? ""))
      if (key.startsWith("cloud:user:Usr001:")) storage.removeItem(key);
    field.value = "After signing out";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index) ?? "");
    expect(keys.filter((key) => key.startsWith("cloud:user:Usr001:"))).toEqual([]);
    expect(field.value).toBe("After signing out");
  });

  /** The first materialization stores the draft, but its answer never arrives; asking again with its key returns it. */
  const loseFirstMaterializeAnswer = () => {
    let committedKey: unknown = null;
    intercept = async ({ path, body }) => {
      if (!path.endsWith("/materialize")) return null;
      if (materializeGate) await materializeGate;
      if (!createdDraftId) {
        committedKey = body!.idempotencyKey;
        createdDraftId = "DraftN";
        saved.DraftN = { ...(body!.draft as Partial<MailDraft>), intent: "reply", revision: 1 };
        throw new TypeError("Connection closed after commit");
      }
      if (body!.idempotencyKey === committedKey)
        return Response.json({ ...draft({ id: "DraftN", ...saved.DraftN }), creationOutcome: "created" });
      return Response.json({ code: "DRAFT_REPLY_BOX_OCCUPIED", message: "The reply place is taken.", draftId: "DraftN" }, { status: 409 });
    };
  };

  test("discarding while the first save's answer is lost asks again with its key and discards the stored draft", async () => {
    const { prompts } = await import("@k2b/ui");
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
    try {
      await mount();
      const release = holdMaterialize();
      loseFirstMaterializeAnswer();
      type("Discard this stored text");
      await waitFor(() => materialized().length === 1);
      dom.root.querySelector<HTMLButtonElement>("[data-mail-reply-discard]")!.click();
      await waitFor(() => confirm.mock.calls.length === 1);
      release();
      // fixed wait: the discard settles after the first save is resolved.
      await Bun.sleep(1_100);
      const keys = materialized().map((request) => request.body!.idempotencyKey);
      expect(new Set(keys).size).toBe(1);
      expect(requests.filter((request) => request.path.endsWith("/DraftN/discard"))).toHaveLength(1);
    } finally {
      confirm.mockRestore();
    }
  }, 15_000);

  test("a mode switch while the first save's answer is lost switches the stored draft and keeps newer typing", async () => {
    await mount();
    const release = holdMaterialize();
    loseFirstMaterializeAnswer();
    type("Original text.");
    await waitFor(() => materialized().length === 1);
    await chooseMode("Forward");
    type(" Newer input.");
    release();
    await waitFor(() => saved.DraftN?.intent === "forward");
    const keys = materialized().map((request) => request.body!.idempotencyKey);
    expect(new Set(keys).size).toBe(1);
    await waitFor(() => boxText().includes("Original text. Newer input."));
    await remount({ drafts: [{ ...summary, id: "DraftN" }] });
    await waitFor(() => boxText().includes("Original text. Newer input."));
  }, 15_000);

  test("text that meets a colleague's reply draft during a mode switch is offered to restore after reopening", async () => {
    createdDraftId = "DraftC";
    await mount();
    intercept = async ({ path }) => {
      if (!path.endsWith("/materialize")) return null;
      if (materializeGate) await materializeGate;
      return Response.json({ code: "DRAFT_REPLY_BOX_OCCUPIED", message: "Occupied", draftId: "DraftC" }, { status: 409 });
    };
    const release = holdMaterialize();
    type("My private local input");
    await waitFor(() => materialized().length === 1);
    await chooseMode("Forward");
    release();
    await waitFor(() => materialized().length === 2);
    // fixed wait: the second seed takes in its occupied answer.
    await Bun.sleep(100);
    expect(boxText()).toContain("My private local input");
    expect(requests.filter((request) => request.path.includes("/DraftC") && request.method !== "GET")).toHaveLength(0);
    await remount({ drafts: [{ ...summary, id: "DraftC" }] });
    await waitFor(() => meanwhileLines().length > 0);
    expect(meanwhileLines()).toHaveLength(1);
    expect(meanwhileLines()[0]).toContain("My private local input");
    expect(requests.filter((request) => request.path.includes("/DraftC") && request.method !== "GET")).toHaveLength(0);
  }, 15_000);

  test("a discard confirmed while a mode switch waits for the first save wins, and the box starts empty", async () => {
    const { prompts } = await import("@k2b/ui");
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
    try {
      const [list, setList] = createSignal<ConversationDraftSummary[]>([]);
      await mount({
        get drafts() {
          return list();
        },
      });
      reconcile = async () => {
        setList([]);
      };
      const release = holdMaterialize();
      type("Discard wins");
      await waitFor(() => materialized().length === 1);
      await chooseMode("Forward");
      dom.root.querySelector<HTMLButtonElement>("[data-mail-reply-discard]")!.click();
      await waitFor(() => confirm.mock.calls.length === 1);
      release();
      await waitFor(() => requests.some((request) => request.path.endsWith("/DraftN/discard")));
      // fixed wait: a switch that went on would send its mode change now.
      await Bun.sleep(1_000);
      expect(requests.some((request) => request.path.endsWith("/DraftN/intent"))).toBe(false);
      await waitFor(() => Boolean(dom.root.querySelector("[data-mail-reply-box='mail'] .cm-content")));
      expect(boxText()).not.toContain("Discard wins");
      expect(dom.root.querySelector("[data-mail-reply-box='mail']")!.getAttribute("data-intent")).toBe("reply");
    } finally {
      confirm.mockRestore();
    }
  }, 15_000);

  test("only the list format of texts typed meanwhile is read; any other stored value offers nothing", async () => {
    const key = `cloud:user:Usr001:mail:reply-box:Box${mailbox}:Conv01:meanwhile`;
    dom.window.localStorage.setItem(key, "A plain text from an unreleased build");
    await mount({ drafts: [summary] });
    // fixed wait: the box has read its stored copies once it shows the draft.
    await Bun.sleep(100);
    expect(meanwhileLines()).toHaveLength(0);
  }, 15_000);

  test("a mode switch after a server error on the first save asks again with its key and keeps all typing", async () => {
    await mount();
    const release = holdMaterialize();
    let failFirst = true;
    intercept = async ({ path }) => {
      if (!path.endsWith("/materialize") || !failFirst) return null;
      if (materializeGate) await materializeGate;
      failFirst = false;
      return Response.json({ code: "UNAVAILABLE", message: "The server is busy." }, { status: 503 });
    };
    type("Must survive the failure.");
    await waitFor(() => materialized().length === 1);
    await chooseMode("Forward");
    type(" And later typing.");
    release();
    await waitFor(() => saved.DraftN?.intent === "forward");
    expect(new Set(materialized().map((request) => request.body!.idempotencyKey)).size).toBe(1);
    await waitFor(() => boxText().includes("Must survive the failure. And later typing."));
    expect(saved.DraftN?.body).toContain("Must survive the failure. And later typing.");
  }, 15_000);
});
