import { LocaleProvider, type PanesLayout } from "@k2b/ui";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { z } from "zod";
import {
  type ComposeFormattingWarning,
  type ComposePreview,
  type DraftIntent,
  draftEditableContentInputSchema,
  type MailDraft,
  type MailDraftSeed,
  materializeDraftSeedInputSchema,
  type SenderIdentity,
} from "../../contracts";
import MailComposer from "./MailComposer";
import MailComposerEditor from "./MailComposerEditor";
import { readMailDraftSeed, storeMailDraftSeed } from "./mail-draft-seed-store";
import { openMailUserDraftStorage } from "./mail-user-draft-storage";

export type MailComposerEditorHarnessOptions = { locale: "en" | "de"; body?: string; editorActive?: boolean };
export type MailComposerHarnessOptions = { locale: "en" | "de"; intent: DraftIntent; signatureTemplateId: string | null; seed?: boolean };

declare global {
  interface Window {
    expireComposerSession: () => void;
    mountComposer: (options: MailComposerHarnessOptions) => void;
    mountComposerEditor: (options: MailComposerEditorHarnessOptions) => void;
    /** Replaces the preview, as a new compose preview response does. */
    setFormattingWarnings: (warnings: ComposeFormattingWarning[]) => void;
    /** Replaces the previewed HTML, as a compose preview response with a signature logo does. */
    setPreviewHtml: (html: string) => void;
    editorBody: () => string;
    replaceEditorBody: (body: string) => void;
    setEditorFormat: (format: "plain" | "markdown") => void;
    setEditorEditable: (editable: boolean) => void;
  }
}

const layout: PanesLayout = { version: 2, root: { type: "group", items: ["editor", "preview"], active: "preview" } };
const html =
  '<div style="font-family:Arial;font-size:15px"><p style="margin:0 0 12px">First paragraph of the message.</p><p>Regards</p></div>';

window.mountComposerEditor = (options) => {
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing harness root");
  document.documentElement.lang = options.locale;
  const [preview, setPreview] = createSignal<ComposePreview>({
    html,
    text: "First paragraph of the message.\n\nRegards",
    formattingWarnings: [],
  });
  const [body, setBody] = createSignal(options.body ?? 'First paragraph <small>of</small> the <span class="x">message</span>.');
  const [panes, setPanes] = createSignal<PanesLayout>(
    options.editorActive ? { version: 2, root: { type: "group", items: ["editor", "preview"], active: "editor" } } : layout,
  );
  const [format, setFormat] = createSignal<"plain" | "markdown">("markdown");
  const [editable, setEditable] = createSignal(true);
  window.editorBody = body;
  window.replaceEditorBody = setBody;
  window.setEditorFormat = setFormat;
  window.setEditorEditable = setEditable;
  window.setFormattingWarnings = (formattingWarnings) => setPreview({ ...preview(), formattingWarnings });
  window.setPreviewHtml = (next) => setPreview({ ...preview(), html: next });
  render(
    () => (
      <LocaleProvider locale={options.locale}>
        <div class="flex min-h-0 w-full flex-1 flex-col">
          <MailComposerEditor
            format={format}
            body={body}
            onBodyInput={setBody}
            editable={editable}
            completions={() => []}
            panes={panes}
            onPanesChange={setPanes}
            preview={preview}
            previewError={() => undefined}
            previewPending={() => false}
            onRetryPreview={() => undefined}
            onEditorReady={() => undefined}
          />
        </div>
      </LocaleProvider>
    ),
    host,
  );
};

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

// Live notifications stay offline; the lease and preview requests use the same mocked HTTP boundary as other composer tests.
class OfflineWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = OfflineWebSocket.CONNECTING;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  send() {}
  close() {
    this.readyState = OfflineWebSocket.CLOSED;
  }
}

window.mountComposer = (options) => {
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing harness root");
  document.documentElement.lang = options.locale;
  const draft = { ...initialDraft, intent: options.intent, signatureTemplateId: options.signatureTemplateId };
  Object.defineProperty(window, "WebSocket", { configurable: true, value: OfflineWebSocket });
  let expired = false;
  window.expireComposerSession = () => {
    expired = true;
  };
  const originalFetch = window.fetch;
  window.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(new URL(String(input), location.href), init);
      const path = new URL(request.url).pathname;
      if (expired) return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
      if (path.endsWith("/draft-seeds/materialize")) {
        const json = materializeDraftSeedInputSchema.parse(await request.json());
        return Response.json({ ...draft, ...json.draft });
      }
      if (path.endsWith("/lease"))
        return Response.json({
          token: crypto.randomUUID(),
          holder: { kind: "user", id: "Usr001", displayName: "Ada", avatarHash: null },
          acquiredAt: now,
          expiresAt: now,
        });
      if (path.endsWith("/compose-preview")) return Response.json({ html: "<p>Hello</p>", text: "Hello", formattingWarnings: [] });
      if (path.endsWith("/drafts/Draft1") && request.method === "PUT") {
        const json = z
          .object({ expectedRevision: z.number().int().positive(), draft: draftEditableContentInputSchema })
          .parse(await request.json());
        return Response.json({ ...draft, ...json.draft, revision: json.expectedRevision + 1 });
      }
      throw new Error(`Unexpected request: ${request.method} ${path}`);
    },
    { preconnect: originalFetch.preconnect },
  );
  const seed: MailDraftSeed = {
    id: "10000000-0000-4000-8000-000000000001",
    mailboxId: "Box001",
    conversationId: null,
    intent: "new",
    sourceMessageId: null,
    derivedFromMessageId: null,
    derivationKind: null,
    content: draftEditableContentInputSchema.strip().parse(draft),
    attachments: [],
    createdAt: now,
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
  };
  const seedStorage = openMailUserDraftStorage(localStorage, "Usr001");
  const restoredSeed = options.seed ? (readMailDraftSeed(seedStorage, "Box001", seed.id) ?? seed) : undefined;
  if (restoredSeed) storeMailDraftSeed(seedStorage, restoredSeed);
  render(
    () => (
      <LocaleProvider locale={options.locale}>
        <MailComposer
          mailboxId="Box001"
          currentActor={{ kind: "user", id: "Usr001" }}
          identities={[identity("Send01", "Support", "Sign01"), identity("Send02", "Sales", "Sign01")]}
          signatures={{
            templates: [
              { id: "Sign01", name: "Support signature" },
              { id: "Sign02", name: "Personal signature" },
              { id: "Sign03", name: "Sales signature" },
            ],
            personalDefaults: [{ senderIdentityId: "Send02", templateId: "Sign03" }],
          }}
          initialDraft={options.seed ? undefined : draft}
          initialSeed={restoredSeed}
          initialPanes={options.seed ? { version: 2, root: { type: "group", items: ["editor", "preview"], active: "editor" } } : layout}
          returnHref="/app/mail/Box001"
          dateConfig={{ locale: options.locale, timeZone: "UTC" }}
        />
      </LocaleProvider>
    ),
    host,
  );
};
