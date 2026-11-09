import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../ui/test/dom";
import type { MailDraft } from "../../contracts";

const MAILBOX_ID = "Box001";
const DRAFT_ID = "Drf001";
const UPLOAD_ID = "30000000-0000-4000-8000-000000000003";
const now = "2026-10-04T10:00:00.000Z";

const draft: MailDraft = {
  id: DRAFT_ID,
  mailboxId: MAILBOX_ID,
  conversationId: null,
  intent: "new",
  sourceMessageId: null,
  derivedFromMessageId: null,
  derivationKind: null,
  quoteSource: null,
  senderIdentityId: "Idn001",
  to: [{ name: null, address: "ada@example.test" }],
  cc: [],
  bcc: [],
  subject: "Report",
  body: "Attached.",
  format: "markdown",
  priority: "normal",
  requestDeliveryReceipt: false,
  requestReadReceipt: false,
  attachments: [],
  suggestion: false,
  createdBy: { kind: "user", userId: "Usr001" },
  lastEditedBy: { kind: "user", userId: "Usr001" },
  lastEditedByDisplayName: "Ada Example",
  recoveryCopyCount: 0,
  revision: 3,
  state: "draft",
  deliveryClass: "normal",
  signatureTemplateId: null,
  createdAt: now,
  updatedAt: now,
};

describe("Mail composer attachments", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  const originalFetch = globalThis.fetch;
  let dom: DomTestHarness;
  let requests: Array<{ method: string; url: string }>;
  let respond: () => Response;
  let dispose = () => {};

  beforeEach(() => {
    dom = createDomTestHarness();
    requests = [];
    respond = () => Response.json({ id: UPLOAD_ID, state: "cancelled" });
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost"), init);
        requests.push({ method: request.method, url: new URL(request.url).pathname });
        return respond();
      },
      { preconnect: originalFetch.preconnect },
    );
  });

  afterEach(() => {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  });

  const mountWithUnfinishedUpload = async () => {
    const { createMailComposerAttachmentManager } = await import("./mail-composer-attachment-manager");
    const { createMailComposerTransition } = await import("./mail-composer-transition");
    const { default: MailComposerAttachments } = await import("./MailComposerAttachments");
    delegateEvents(["click"]);
    let manager: ReturnType<typeof createMailComposerAttachmentManager> | undefined;
    dispose = render(() => {
      const [current, setCurrent] = createSignal<MailDraft | null>(draft);
      manager = createMailComposerAttachmentManager({
        mailboxId: MAILBOX_ID,
        draft: current,
        initialAttachments: () => [],
        unfinishedUploads: [{ id: UPLOAD_ID, filename: "report.pdf", byteLength: 4_000_000, receivedBytes: 1_000_000 }],
        setDraft: setCurrent,
        editable: () => true,
        persist: async () => current(),
        serializeDraftMutation: (operation) => operation(),
        transition: createMailComposerTransition(),
        format: () => "markdown",
        insertText: () => undefined,
        isDisposed: () => false,
        locale: () => "en",
      });
      return createComponent(MailComposerAttachments, {
        attachments: () => [],
        uploads: manager.uploads,
        editable: () => true,
        canShare: false,
        shareLoading: () => false,
        onInsertLink: () => undefined,
        onRemove: () => undefined,
        onRetryUpload: (upload) => void manager!.retryUpload(upload),
        onCancelUpload: (upload) => void manager!.cancelUpload(upload),
      });
    }, dom.root);

    return manager!;
  };

  test("an upload a closed tab left unfinished shows on reopening and can be cancelled, so it no longer blocks Send", async () => {
    const manager = await mountWithUnfinishedUpload();

    // The composer blocks Send while any upload is listed, like the server does.
    expect(manager.uploads()).toHaveLength(1);
    expect(dom.root.textContent).toContain("report.pdf");
    expect(dom.root.textContent).toContain("Upload not finished");
    // The file stayed in the closed tab, so the upload cannot be retried from here.
    expect(dom.root.querySelector('[aria-label="Retry report.pdf"]')).toBeNull();

    dom.root.querySelector<HTMLButtonElement>('[aria-label="Cancel report.pdf"]')!.click();
    for (let i = 0; i < 50 && manager.uploads().length > 0; i++) await Bun.sleep(10);

    expect(requests).toEqual([
      { method: "DELETE", url: `/api/mail/mailboxes/${MAILBOX_ID}/drafts/${DRAFT_ID}/attachment-uploads/${UPLOAD_ID}` },
    ]);
    expect(manager.uploads()).toEqual([]);
    expect(dom.root.textContent).not.toContain("report.pdf");
  });

  test("an unfinished upload that its own session finished meanwhile leaves the list on cancel instead of failing", async () => {
    respond = () => Response.json({ code: "CONFLICT", message: "An attached upload cannot be cancelled" }, { status: 409 });
    const manager = await mountWithUnfinishedUpload();

    dom.root.querySelector<HTMLButtonElement>('[aria-label="Cancel report.pdf"]')!.click();
    for (let i = 0; i < 50 && manager.uploads().length > 0; i++) await Bun.sleep(10);

    expect(requests).toHaveLength(1);
    expect(manager.uploads()).toEqual([]);
  });

  test.each(["Retry", "Cancel"])(
    "a finished upload whose answer got lost attaches exactly once on %s and stops blocking Send",
    async (action) => {
      const attachment = {
        id: "Att001",
        filename: "report.pdf",
        contentType: "application/pdf",
        byteLength: 3,
        contentHash: "c".repeat(64),
        position: 0,
        createdAt: now,
      };
      let finalizes = 0;
      let serverAttached = false;
      respond = () => Response.json({});
      globalThis.fetch = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost"), init);
          const path = new URL(request.url).pathname;
          requests.push({ method: request.method, url: path });
          if (request.method === "POST" && path.endsWith("/attachment-uploads")) return Response.json({ id: UPLOAD_ID, chunkSize: 1024 });
          if (request.method === "PATCH") return Response.json({});
          if (path.endsWith("/finalize")) {
            finalizes += 1;
            serverAttached = true;
            // The server commits the attachment; only its answer goes missing the first time.
            if (finalizes === 1) throw new TypeError("Failed to fetch");
            return Response.json({ ...draft, revision: 4, attachments: [attachment] });
          }
          if (request.method === "DELETE")
            return serverAttached
              ? Response.json({ code: "CONFLICT", message: "An attached upload cannot be cancelled" }, { status: 409 })
              : Response.json({ id: UPLOAD_ID, state: "cancelled" });
          throw new Error(`Unexpected ${request.method} ${path}`);
        },
        { preconnect: originalFetch.preconnect },
      );
      const { createMailComposerAttachmentManager } = await import("./mail-composer-attachment-manager");
      const { createMailComposerTransition } = await import("./mail-composer-transition");
      const { default: MailComposerAttachments } = await import("./MailComposerAttachments");
      delegateEvents(["click"]);
      let manager: ReturnType<typeof createMailComposerAttachmentManager> | undefined;
      let current: () => MailDraft | null = () => null;
      dispose = render(() => {
        const [value, setValue] = createSignal<MailDraft | null>(draft);
        current = value;
        manager = createMailComposerAttachmentManager({
          mailboxId: MAILBOX_ID,
          draft: value,
          initialAttachments: () => [],
          unfinishedUploads: [],
          setDraft: setValue,
          editable: () => true,
          persist: async () => value(),
          serializeDraftMutation: (operation) => operation(),
          transition: createMailComposerTransition(),
          format: () => "markdown",
          insertText: () => undefined,
          isDisposed: () => false,
          locale: () => "en",
        });
        return createComponent(MailComposerAttachments, {
          attachments: () => value()?.attachments ?? [],
          uploads: manager.uploads,
          editable: () => true,
          canShare: false,
          shareLoading: () => false,
          onInsertLink: () => undefined,
          onRemove: () => undefined,
          onRetryUpload: (upload) => void manager!.retryUpload(upload),
          onCancelUpload: (upload) => void manager!.cancelUpload(upload),
        });
      }, dom.root);

      await manager!.addFiles([new File(["abc"], "report.pdf", { type: "application/pdf" })]);
      expect(manager!.uploads()).toHaveLength(1);
      expect(manager!.uploads()[0]?.error).not.toBeNull();

      // Cancel cannot take back what the server attached; the attachment shows and can be removed like any other.
      dom.root.querySelector<HTMLButtonElement>(`[aria-label="${action} report.pdf"]`)!.click();
      while (manager!.uploads().length > 0) await Bun.sleep(10);

      expect(manager!.uploads()).toEqual([]);
      expect(current()?.attachments).toEqual([attachment]);
      expect(requests.filter((request) => request.method === "POST" && request.url.endsWith("/attachment-uploads"))).toHaveLength(1);
      expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
    },
  );
});
