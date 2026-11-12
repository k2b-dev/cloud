import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { createSignal } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../ui/test/dom";
import type { ConversationDraftSummary, MailDraft, MailDraftSeed, SenderIdentity } from "../../contracts";
import type { MessageDetail } from "../../service/messages";
import type { MailComposerHost, MailInlineDraftControls } from "./MailComposer";
import type { MailReplyBoxApi } from "./MailReplyBox";

const now = "2026-11-12T10:00:00.000Z";
const message: MessageDetail = {
  id: "Msg001",
  subject: "Workbench",
  messageId: "<workbench@example.test>",
  internalDate: now,
  sentAt: now,
  from: [{ name: "Mara Lindqvist", address: "mara@example.test" }],
  to: [{ name: null, address: "shop@example.test" }],
  preview: "",
  hasAttachments: false,
  replyTo: [],
  cc: [],
  flags: [],
  keywords: [],
  hydrationStatus: "complete",
  remoteAvailable: true,
  folderId: "Fold01",
  deletedOnServer: false,
  contentType: "text/plain",
  sizeBytes: 64,
  plainText: "Hello",
  sanitizedHtml: null,
  forwardText: "",
  selectedHeaders: {},
  sourceAvailable: false,
  mailingList: null,
  remoteContent: { imageIds: [], allowedByRule: false, allowRules: [], sender: "mara@example.test", domain: "example.test" },
  delivery: null,
  attachments: [],
};
const identity = {
  id: "Send01",
  mailboxId: "Box001",
  label: "Shop",
  displayName: "Shop",
  fromAddress: "shop@example.test",
  isDefault: true,
  status: "verified",
} as SenderIdentity;
const draft = (overrides: Partial<MailDraft> = {}): MailDraft =>
  ({
    id: "Draft1",
    mailboxId: "Box001",
    conversationId: "Conv01",
    intent: "reply",
    sourceMessageId: "Msg001",
    senderIdentityId: "Send01",
    to: [{ name: "Mara Lindqvist", address: "mara@example.test" }],
    cc: [],
    bcc: [],
    subject: "Re: Workbench",
    body: "Reply text",
    revision: 3,
    state: "draft",
    attachments: [],
    suggestion: false,
    consolidatedCount: 0,
    ...overrides,
  }) as MailDraft;
const summary = (overrides: Partial<ConversationDraftSummary> = {}): ConversationDraftSummary => ({
  id: "Draft1",
  intent: "reply",
  subject: "Re: Workbench",
  updatedAt: now,
  suggestion: false,
  bodyPreview: "Reply text",
  createdByDisplayName: "Jule",
  ...overrides,
});

const waitFor = async (condition: () => boolean) => {
  // Bounded by the test's own timeout.
  while (!condition()) await Bun.sleep(5);
};

describe("MailReplyBox", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }
  const originalFetch = globalThis.fetch;
  let dom: DomTestHarness;
  let dispose = () => {};
  let requests: Array<{ method: string; path: string; body: unknown }>;
  let mounts: Array<{ host: MailComposerHost; initialDraft?: MailDraft; initialSeed?: MailDraftSeed; controls: MailInlineDraftControls }>;
  let composerMock: Mock<(...args: never[]) => unknown> | undefined;
  /** What the fake composer holds as typed text. */
  let typed = "";
  let commentFailure: { status: number; message: string } | "offline" | null = null;
  let mailbox = 0;

  const posts = (suffix: string) => requests.filter((request) => request.method === "POST" && request.path.endsWith(suffix));
  const _controls = () => mounts.at(-1)!.controls;
  const host = () => mounts.at(-1)!.host;

  beforeEach(async () => {
    dom = createDomTestHarness();
    delegateEvents(["click", "keydown", "input"]);
    requests = [];
    mounts = [];
    typed = "";
    commentFailure = null;
    mailbox += 1;
    dom.window.sessionStorage.clear();
    const composer = await import("./MailComposer");
    composerMock = spyOn(composer, "default").mockImplementation(((props: {
      host: MailComposerHost;
      initialDraft?: MailDraft;
      initialSeed?: MailDraftSeed;
    }) => {
      const fake: MailInlineDraftControls = {
        collapse: spyOn({ fn: async () => props.host.leave("closed") }, "fn"),
        send: spyOn({ fn: () => undefined }, "fn"),
        sendAt: spyOn({ fn: (_at: string) => undefined }, "fn"),
        focusText: () => undefined,
        ready: () => true,
        text: () => typed,
        changed: () => typed !== "",
        appendText: spyOn({ fn: (_text: string) => undefined }, "fn"),
        release: spyOn({ fn: async () => undefined }, "fn"),
        forgetLocal: spyOn({ fn: () => undefined }, "fn"),
      };
      props.host.register(fake);
      mounts.push({ host: props.host, initialDraft: props.initialDraft, initialSeed: props.initialSeed, controls: fake });
      return (
        <section data-mail-reply-box="mail" data-test-draft={props.initialDraft?.id ?? "seed"}>
          {props.host.box?.banner?.()}
          {props.host.box?.modeMenu()}
        </section>
      );
    }) as never) as never;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost"), init);
        const path = new URL(request.url).pathname;
        const raw = request.method === "GET" ? "" : await request.text();
        const body: unknown = raw ? JSON.parse(raw) : null;
        requests.push({ method: request.method, path, body });
        if (path.endsWith("/draft-seeds")) {
          const input = (body as { origin: { input: { intent: string; sourceMessageId: string; body: string } } }).origin.input;
          return Response.json({
            id: `seed-${input.intent}`,
            mailboxId: "Box001",
            conversationId: "Conv01",
            intent: input.intent,
            sourceMessageId: input.sourceMessageId,
            content: { body: input.body },
            attachments: [],
            origin: { kind: "compose", input },
            createdAt: now,
          });
        }
        if (/\/drafts\/Draft\d$/.test(path)) return Response.json(draft({ id: path.split("/").at(-1)! }));
        if (path.endsWith("/attachment-uploads")) return Response.json([]);
        if (path.endsWith("/intent")) {
          const intent = (body as { intent: MailDraft["intent"] }).intent;
          return Response.json(draft({ intent, revision: 4, to: [] }));
        }
        if (path.endsWith("/consolidation/acknowledge")) return Response.json(draft({ consolidatedCount: 0 }));
        if (path.endsWith("/cancel")) return Response.json({ draftId: "Draft2" });
        if (path.endsWith("/comments")) {
          if (commentFailure === "offline") {
            Object.defineProperty(dom.window.navigator, "onLine", { configurable: true, value: false });
            throw new TypeError("Failed to fetch");
          }
          if (commentFailure) return Response.json({ message: commentFailure.message }, { status: commentFailure.status });
          return Response.json({ id: "Note01", conversationId: "Conv01", body: (body as { body: string }).body });
        }
        return Response.json([]);
      },
      { preconnect: originalFetch.preconnect },
    );
  });
  afterEach(() => {
    dispose();
    composerMock?.mockRestore();
    globalThis.fetch = originalFetch;
    Reflect.deleteProperty(dom.window.navigator, "onLine");
    dom.cleanup();
  });

  const mount = async (
    options: { drafts?: () => ConversationDraftSummary[]; messages?: () => MessageDetail[]; onReconcile?: () => Promise<void> } = {},
  ) => {
    const [{ default: MailReplyBox }, { LocaleProvider }] = await Promise.all([import("./MailReplyBox"), import("@k2b/ui")]);
    let api: MailReplyBoxApi | undefined;
    const reconciles: number[] = [];
    dispose = render(
      () => (
        <LocaleProvider locale="en">
          <MailReplyBox
            mailboxId={`Box${mailbox}`}
            conversationId="Conv01"
            subject="Workbench"
            messages={options.messages?.() ?? [message]}
            conversationDrafts={options.drafts?.() ?? []}
            identities={[identity]}
            canReplyAll={true}
            customerName="Mara Lindqvist"
            currentUserId="Usr001"
            currentUserEmail={null}
            dateConfig={{ locale: "en", timeZone: "Europe/Berlin" }}
            canAdmin={false}
            mailboxRecipientSuggestions={true}
            calendarIntegrationAvailable={false}
            liveDictation={false}
            returnHref="/app/mail/Box001"
            messageLabel={() => null}
            createNote={async (text, failed) => {
              const response = await fetch(`/api/mail/mailboxes/Box001/conversations/Conv01/comments`, {
                method: "POST",
                body: JSON.stringify({ body: text }),
              });
              if (!response.ok) throw new Error(((await response.json()) as { message?: string }).message ?? failed);
              return response.json();
            }}
            onReconcile={async () => {
              reconciles.push(Date.now());
              await options.onReconcile?.();
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
    await waitFor(() => mounts.length > 0);
    return { api: () => api!, reconciles };
  };
  const chooseMode = async (label: string) => {
    dom.root.querySelector<HTMLButtonElement>("[data-mail-reply-mode]")!.click();
    await waitFor(() =>
      Array.from(dom.document.querySelectorAll('[role="menuitemradio"]')).some((item) => item.textContent?.includes(label)),
    );
    Array.from(dom.document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))
      .find((item) => item.textContent?.includes(label))!
      .click();
  };
  const noteField = () => dom.root.querySelector<HTMLTextAreaElement>("[data-mail-reply-box='note'] textarea")!;
  const writeNote = (text: string) => {
    noteField().value = text;
    noteField().dispatchEvent(new Event("input", { bubbles: true }));
  };
  const modEnter = (target: Element) =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
  /** No draft write of any kind, and no send. */
  const noDraftWrites = () =>
    requests.filter(
      (request) =>
        request.method !== "GET" &&
        (request.path.includes("/drafts") || request.path.endsWith("/commands") || request.path.includes("/materialize")),
    );
  const noSend = () => {
    for (const mounted of mounts) {
      expect(mounted.controls.send).not.toHaveBeenCalled();
      expect(mounted.controls.sendAt).not.toHaveBeenCalled();
      expect(mounted.controls.appendText).not.toHaveBeenCalled();
    }
  };

  test("opening a conversation without a reply draft prepares a seed and creates no draft", async () => {
    await mount();
    expect(mounts[0]!.initialSeed?.intent).toBe("reply");
    expect(mounts[0]!.host.box?.autofocus).toBe(false);
    await Bun.sleep(30);
    expect(posts("/draft-seeds")).toHaveLength(1);
    expect(noDraftWrites()).toEqual([]);
  });

  test("an existing reply draft opens in its mode; switching keeps its text through the mode API", async () => {
    await mount({ drafts: () => [summary({ intent: "reply" })] });
    expect(mounts[0]!.initialDraft?.id).toBe("Draft1");
    await chooseMode("Forward");
    await waitFor(() => mounts.length === 2);
    expect(mounts[0]!.controls.collapse).toHaveBeenCalledWith({ preserveDraft: true });
    expect(posts("/intent").map((call) => call.body)).toEqual([{ intent: "forward", expectedRevision: 3 }]);
    expect(mounts[1]!.initialDraft?.intent).toBe("forward");
    expect(mounts[1]!.initialDraft?.body).toBe("Reply text");
    expect(requests.some((request) => request.method === "PUT" || request.path.endsWith("/discard"))).toBe(false);
  });

  test("switching the mode of a seed carries typed text over without creating a draft", async () => {
    await mount();
    typed = "Typed before switching";
    await chooseMode("Reply all");
    await waitFor(() => mounts.length === 2);
    expect(mounts[0]!.controls.forgetLocal).toHaveBeenCalled();
    expect(mounts[1]!.initialSeed?.intent).toBe("reply_all");
    await waitFor(() => (mounts[1]!.controls.appendText as Mock<(text: string) => void>).mock.calls.length === 1);
    expect(mounts[1]!.controls.appendText).toHaveBeenCalledWith("Typed before switching");
    expect(noDraftWrites()).toEqual([]);
  });

  describe("internal note (never a mail)", () => {
    test("Mod+Enter in note mode saves the note and never sends", async () => {
      await mount({ drafts: () => [summary()] });
      await chooseMode("Internal note");
      await waitFor(() => Boolean(dom.root.querySelector("[data-mail-reply-box='note']")));
      expect(host().box!.suspended()).toBe(true);
      writeNote("Order the oak before Friday");
      modEnter(noteField());
      await waitFor(() => posts("/comments").length === 1);
      expect(posts("/comments")[0]!.body).toEqual({ body: "Order the oak before Friday" });
      // A held key repeats; Mod+Enter on the note's own button area never reaches the draft either.
      modEnter(dom.root.querySelector("[data-mail-reply-box-frame]")!);
      await Bun.sleep(30);
      noSend();
      expect(noDraftWrites()).toEqual([]);
      await waitFor(() => !dom.root.querySelector("[data-mail-reply-box='note']"));
      expect(host().box!.suspended()).toBe(false);
    });

    test("Save note writes only a comment; the reply draft stays and comes back unchanged", async () => {
      await mount({ drafts: () => [summary()] });
      await chooseMode("Internal note");
      await waitFor(() => Boolean(noteField()));
      const saveButton = () => dom.root.querySelector<HTMLButtonElement>("[data-mail-note-save]")!;
      expect(saveButton().disabled).toBe(true);
      expect(dom.root.textContent).toContain("Only for the team. Mara Lindqvist never sees it.");
      expect(dom.root.textContent).toContain("Your reply draft stays saved");
      expect(mounts[0]!.controls.release).toHaveBeenCalled();
      writeNote("Internal only");
      saveButton().click();
      await waitFor(() => posts("/comments").length === 1);
      await waitFor(() => !dom.root.querySelector("[data-mail-reply-box='note']"));
      // The same draft composer stays mounted all along: no reload, no write.
      expect(mounts).toHaveLength(1);
      expect(noDraftWrites()).toEqual([]);
      noSend();
      expect(dom.window.sessionStorage.getItem(`cloud:mail:reply-note:Box${mailbox}:Conv01`)).toBeNull();
    });

    test("switching modes with text keeps note text out of the draft and keeps it for later", async () => {
      await mount({ drafts: () => [summary()] });
      await chooseMode("Internal note");
      await waitFor(() => Boolean(noteField()));
      writeNote("Note text that must stay internal");
      await chooseMode("Reply");
      await waitFor(() => !dom.root.querySelector("[data-mail-reply-box='note']"));
      expect(host().box!.suspended()).toBe(false);
      noSend();
      expect(noDraftWrites()).toEqual([]);
      expect(JSON.stringify(requests)).not.toContain("Note text that must stay internal");
      expect(posts("/comments")).toEqual([]);
      await chooseMode("Internal note");
      await waitFor(() => Boolean(noteField()));
      expect(noteField().value).toBe("Note text that must stay internal");
    });

    test("after a failed send, switching to note suspends the draft and saving writes only the note", async () => {
      await mount({ drafts: () => [summary()] });
      // The composer reported a failed send in its own bar; the person turns to a note instead.
      await chooseMode("Internal note");
      await waitFor(() => Boolean(noteField()));
      expect(host().box!.suspended()).toBe(true);
      writeNote("Mail server is down, I call her");
      dom.root.querySelector<HTMLButtonElement>("[data-mail-note-save]")!.click();
      await waitFor(() => posts("/comments").length === 1);
      noSend();
      expect(noDraftWrites()).toEqual([]);
    });

    test("a failed note save turns the bar light red, keeps the text, and saves again", async () => {
      await mount();
      await chooseMode("Internal note");
      await waitFor(() => Boolean(noteField()));
      writeNote("Keep me");
      commentFailure = { status: 503, message: "The server is busy." };
      dom.root.querySelector<HTMLButtonElement>("[data-mail-note-save]")!.click();
      await waitFor(() => Boolean(dom.root.querySelector("[data-mail-note-failed]")));
      expect(dom.root.querySelector("[data-mail-note-failed]")!.textContent).toContain(
        "Not saved. The server is busy. Your text stays here.",
      );
      expect(noteField().value).toBe("Keep me");
      commentFailure = null;
      dom.root.querySelector<HTMLButtonElement>("[data-mail-note-retry]")!.click();
      await waitFor(() => !dom.root.querySelector("[data-mail-reply-box='note']"));
      expect(posts("/comments")).toHaveLength(2);
      noSend();
    });

    test("offline, a note save keeps the text and says why", async () => {
      await mount();
      await chooseMode("Internal note");
      await waitFor(() => Boolean(noteField()));
      writeNote("Offline note");
      commentFailure = "offline";
      modEnter(noteField());
      await waitFor(() => Boolean(dom.root.querySelector("[data-mail-note-failed]")));
      expect(dom.root.textContent).toContain("You are offline. Save the note once you are back online.");
      expect(noteField().value).toBe("Offline note");
      noSend();
      expect(noDraftWrites()).toEqual([]);
    });

    test("a colleague editing the reply draft while I write a note changes neither the note nor the draft", async () => {
      const [drafts, setDrafts] = createSignal([summary()]);
      await mount({ drafts });
      await chooseMode("Internal note");
      await waitFor(() => Boolean(noteField()));
      writeNote("My note");
      setDrafts([summary({ bodyPreview: "Reply text, edited by Tom", updatedAt: "2026-11-12T10:05:00.000Z" })]);
      await Bun.sleep(40);
      expect(mounts).toHaveLength(1);
      expect(noteField().value).toBe("My note");
      expect(host().box!.suspended()).toBe(true);
      modEnter(noteField());
      await waitFor(() => posts("/comments").length === 1);
      noSend();
      expect(noDraftWrites()).toEqual([]);
    });

    test("mail mode never creates a comment: Mod+Enter in the reply stays with the draft", async () => {
      await mount({ drafts: () => [summary()] });
      modEnter(dom.root.querySelector("[data-mail-reply-box-frame]")!);
      await Bun.sleep(30);
      expect(posts("/comments")).toEqual([]);
      expect(dom.root.querySelector("[data-mail-reply-box='note']")).toBeNull();
    });

    test("unsaved note text survives leaving the conversation and brings the box back in note mode", async () => {
      await mount();
      await chooseMode("Internal note");
      await waitFor(() => Boolean(noteField()));
      writeNote("Half a thought");
      dispose();
      dom.root.textContent = "";
      mounts = [];
      await mount();
      await waitFor(() => Boolean(noteField()));
      expect(noteField().value).toBe("Half a thought");
      expect(host().box!.suspended()).toBe(true);
    });
  });

  test("while the last reply waits in its undo window, the box takes typing and holds the draft back", async () => {
    const [messages, setMessages] = createSignal<MessageDetail[]>([
      message,
      {
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
      },
    ]);
    const { api } = await mount({ messages });
    expect(mounts[0]!.initialSeed).toBeDefined();
    // The seed answers the newest message that can be answered, not the pending one.
    expect(mounts[0]!.initialSeed!.sourceMessageId).toBe("Msg001");
    expect(host().box!.holdCreate()).toBe(true);
    typed = "Written during the undo window";
    // Undo: the restored draft takes the box; what was typed meanwhile waits as a copy to restore.
    api().openDraft("Draft1");
    await waitFor(() => mounts.length === 2);
    expect(mounts[0]!.controls.forgetLocal).toHaveBeenCalled();
    expect(mounts[1]!.initialDraft?.id).toBe("Draft1");
    await waitFor(() => Boolean(dom.root.querySelector("[data-mail-reply-meanwhile]")));
    Array.from(dom.root.querySelectorAll<HTMLButtonElement>("[data-mail-reply-meanwhile] button"))
      .find((button) => button.textContent === "Restore changes")!
      .click();
    await waitFor(() => (mounts[1]!.controls.appendText as Mock<(text: string) => void>).mock.calls.length === 1);
    expect(mounts[1]!.controls.appendText).toHaveBeenCalledWith("Written during the undo window");
    // The other order: the window ends and the hold lifts, so the seed's own autosave creates the next draft.
    setMessages([message]);
    expect(mounts[1]!.host.box!.holdCreate()).toBe(false);
  });

  test("the hold lifts by itself once the send has left", async () => {
    const pending = { ...message, id: "Msg002", delivery: { state: "undo_window", undoUntil: now, lastErrorCode: null } };
    const [messages, setMessages] = createSignal<MessageDetail[]>([message, pending as MessageDetail]);
    await mount({ messages });
    expect(host().box!.holdCreate()).toBe(true);
    setMessages([message, { ...pending, delivery: { ...pending.delivery, state: "sent" } } as MessageDetail]);
    expect(host().box!.holdCreate()).toBe(false);
    expect(mounts).toHaveLength(1);
  });

  test("after Send the box is empty again and puts the caret back in", async () => {
    const { reconciles } = await mount({ drafts: () => [summary()] });
    host().leave("sent");
    await waitFor(() => mounts.length === 2);
    expect(reconciles).toHaveLength(1);
    expect(mounts[1]!.initialSeed).toBeDefined();
    expect(mounts[1]!.host.box!.autofocus).toBe(true);
  });

  test("the one-time consolidation line names how many drafts were here and is acknowledged once", async () => {
    const consolidated = draft({ consolidatedCount: 2 });
    const serve = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith("/drafts/Draft1") && (input instanceof Request ? input.method : (init?.method ?? "GET")) === "GET") {
          requests.push({ method: "GET", path: "/drafts/Draft1", body: null });
          return Response.json(consolidated);
        }
        return serve(input, init);
      },
      { preconnect: originalFetch.preconnect },
    );
    await mount({ drafts: () => [summary()] });
    await waitFor(() => Boolean(dom.root.querySelector("[data-mail-reply-consolidated]")));
    expect(dom.root.textContent).toContain("There were 3 drafts here. The most recently edited one is in the box.");
    expect(dom.root.querySelector("[data-mail-reply-consolidated]")!.textContent).not.toContain("Insert");
    dom.root.querySelector<HTMLButtonElement>("[data-mail-reply-consolidated] button")!.click();
    await waitFor(() => !dom.root.querySelector("[data-mail-reply-consolidated]"));
    expect(posts("/consolidation/acknowledge")).toHaveLength(1);
  });

  test("a scheduled reply shows its time; Cancel and edit brings the draft back into the box", async () => {
    const scheduled = {
      ...message,
      id: "Msg002",
      delivery: {
        submissionId: "Sub002",
        draftId: "Draft2",
        state: "scheduled",
        scheduledAt: "2026-11-13T07:00:00.000Z",
        undoUntil: null,
        lastErrorCode: null,
      },
    } as MessageDetail;
    const [messages, setMessages] = createSignal<MessageDetail[]>([message, scheduled]);
    dispose = () => {};
    const [{ default: MailReplyBox }, { LocaleProvider }] = await Promise.all([import("./MailReplyBox"), import("@k2b/ui")]);
    dispose = render(
      () => (
        <LocaleProvider locale="en">
          <MailReplyBox
            mailboxId={`Box${mailbox}`}
            conversationId="Conv01"
            subject="Workbench"
            messages={messages()}
            conversationDrafts={[]}
            identities={[identity]}
            canReplyAll={true}
            customerName="Mara Lindqvist"
            currentUserId="Usr001"
            currentUserEmail={null}
            dateConfig={{ locale: "en", timeZone: "Europe/Berlin" }}
            canAdmin={false}
            mailboxRecipientSuggestions={true}
            calendarIntegrationAvailable={false}
            liveDictation={false}
            returnHref="/app/mail/Box001"
            messageLabel={() => null}
            createNote={async () => {
              throw new Error("never");
            }}
            onReconcile={async () => {
              setMessages([message]);
            }}
            onExplainSenderUnavailable={() => undefined}
            register={() => undefined}
          />
        </LocaleProvider>
      ),
      dom.root,
    );
    await waitFor(() => Boolean(dom.root.querySelector("[data-mail-reply-box='scheduled']")));
    expect(dom.root.textContent).toContain("Send scheduled:");
    expect(mounts).toHaveLength(0);
    Array.from(dom.root.querySelectorAll<HTMLButtonElement>("[data-mail-reply-box='scheduled'] button"))
      .find((button) => button.textContent === "Cancel and edit")!
      .click();
    await waitFor(() => mounts.length === 1);
    expect(posts("/cancel").map((call) => call.body)).toEqual([{ disposition: "draft" }]);
    expect(mounts[0]!.initialDraft?.id).toBe("Draft2");
  });

  test("a draft detached into a window leaves a line to bring it back", async () => {
    await mount({ drafts: () => [summary()] });
    host().leave("moved");
    await waitFor(() => Boolean(dom.root.querySelector("[data-mail-reply-box='detached']")));
    expect(dom.root.textContent).toContain("Opened in a window");
    dom.root.querySelector<HTMLButtonElement>("[data-mail-reply-box='detached'] button")!.click();
    await waitFor(() => mounts.length === 2);
    expect(mounts[1]!.initialDraft?.id).toBe("Draft1");
  });
});
