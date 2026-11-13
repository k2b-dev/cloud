import { render } from "solid-js/web";
import { DEFAULT_MAIL_CONTACT_DIRECTORY } from "../../contact-directory-settings";
import type { MailDraft, MailDraftSeed } from "../../contracts";
import MailComposeIntentPage from "./MailComposeIntentPage.island";

declare global {
  interface Window {
    /** Answers the pending draft-seed request, so a test can look at the page while the message is prepared. */
    answerSeed: () => void;
    seedRequests: unknown[];
  }
}

const seed: MailDraftSeed = {
  id: "20000000-0000-4000-8000-000000000002",
  mailboxId: "mail01",
  conversationId: null,
  intent: "new",
  sourceMessageId: null,
  derivedFromMessageId: null,
  derivationKind: null,
  content: {
    quoteSource: null,
    senderIdentityId: "Send01",
    to: [{ name: null, address: "ada@example.test" }],
    cc: [],
    bcc: [],
    subject: "Hello",
    body: "",
    format: "markdown",
    priority: "normal",
    requestDeliveryReceipt: false,
    requestReadReceipt: false,
  },
  attachments: [],
  origin: { kind: "compose", input: { quoteSource: null, senderIdentityId: "Send01", to: [], cc: [], bcc: [], subject: "", body: "" } },
  createdAt: "2026-11-06T10:00:00.000Z",
};

/** The draft the server materializes from the seed; Mail then opens it as a window (`?draft=`). */
const draft: MailDraft = {
  ...seed.content,
  id: "Drf0New1",
  mailboxId: seed.mailboxId,
  conversationId: null,
  intent: "new",
  sourceMessageId: null,
  derivedFromMessageId: null,
  derivationKind: null,
  attachments: [],
  suggestion: false,
  suggestedBy: null,
  createdBy: { kind: "user", userId: "Usr001" },
  lastEditedBy: { kind: "user", userId: "Usr001" },
  lastEditedByDisplayName: "Reader",
  recoveryCopyCount: 0,
  revision: 1,
  state: "draft",
  deliveryClass: "normal",
  signatureTemplateId: null,
  createdAt: seed.createdAt,
  updatedAt: seed.createdAt,
};

window.seedRequests = [];
const answered = new Promise<void>((resolve) => {
  window.answerSeed = resolve;
});
const realFetch = window.fetch.bind(window);
window.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.pathname === "/api/mail/mailboxes/mail01/draft-seeds/materialize") return Response.json(draft);
    if (url.pathname !== "/api/mail/mailboxes/mail01/draft-seeds") return realFetch(input, init);
    window.seedRequests.push(await new Request(input, init).json());
    await answered;
    return Response.json(seed);
  },
  { preconnect: window.fetch.preconnect },
);

render(
  () => (
    <MailComposeIntentPage
      currentUserId="Usr001"
      mailboxes={[{ id: "mail01", name: "Support", description: null, canManage: false }]}
      initialMailboxId="mail01"
      directIdentityId="Send01"
      autoStart={false}
      mailto="mailto:ada@example.test?subject=Hello"
      returnHref="/origin"
      contactDirectory={DEFAULT_MAIL_CONTACT_DIRECTORY}
      currentUserEmail={null}
    />
  ),
  document.getElementById("root")!,
);
