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
  createdBy: { kind: "user", userId: "Usr001" },
  lastEditedBy: { kind: "user", userId: "Usr001" },
  lastEditedByDisplayName: "Ada Example",
  recoveryCopyCount: 0,
  revision: 3,
  state: "draft",
  deliveryClass: "normal",
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
        setBody: () => undefined,
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
});
