import type { DateContext } from "@k2b/stdlib";
import { LocaleProvider } from "@k2b/ui";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import type { MessageDetail } from "../../service/messages";
import MailConversationReader from "./MailConversationReader";

/** The real reader with one message whose body has not arrived; the test answers its body requests. */
declare global {
  interface Window {
    mountReader: (locale: "en" | "de") => void;
    setHydration: (status: string) => void;
  }
}

const now = "2026-08-16T12:00:00.000Z";
const pending: MessageDetail = {
  id: "Msg001",
  subject: "Quarterly review",
  messageId: "<quarterly-review@example.test>",
  internalDate: now,
  sentAt: now,
  from: [{ name: "Ada Example", address: "ada@example.test" }],
  to: [],
  preview: "",
  hasAttachments: false,
  replyTo: [],
  cc: [],
  flags: [],
  keywords: [],
  hydrationStatus: "envelope",
  remoteAvailable: true,
  folderId: "Fold01",
  deletedOnServer: false,
  contentType: "text/plain",
  sizeBytes: 64,
  plainText: null,
  sanitizedHtml: null,
  forwardText: "",
  selectedHeaders: {},
  sourceAvailable: false,
  mailingList: null,
  remoteContent: { imageIds: [], allowedByRule: false, allowRules: [], sender: "ada@example.test", domain: "example.test" },
  delivery: null,
  attachments: [],
};

const noop = () => {};

window.mountReader = (locale) => {
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing harness root");
  const [message, setMessage] = createSignal(pending);
  window.setHydration = (status) => setMessage({ ...pending, hydrationStatus: status });
  render(
    () => (
      <LocaleProvider locale={locale}>
        <div id="reader" class="flex h-[100dvh] min-h-0 flex-col overflow-hidden bg-[var(--ui-surface-raised)]">
          <MailConversationReader
            currentUserId="Usr001"
            mailboxId="Box001"
            requestUrl="/app/mail/Box001?conversation=Conv01"
            canWrite
            canAdmin={false}
            mailboxWide
            identities={[]}
            onOpenDeliverySettings={noop}
            selectionKey="Conv01"
            selectedConversationId="Conv01"
            selectedMessageId={null}
            unread={false}
            flagged={false}
            inJunk={false}
            keep={null}
            reference={null}
            subject={pending.subject}
            messages={[message()]}
            activity={[]}
            conversationSummary={null}
            conversationDrafts={[]}
            totalMessageCount={1}
            error={null}
            dateConfig={{ locale, timeZone: "Europe/Berlin" } as DateContext}
            readingFormat="automatic"
            theme="light"
            calendarIntegrationAvailable={false}
            listAway={false}
            detailsOpen={false}
            toolbarActions={["reply"]}
            onToggleDetails={noop}
            onToolbarActionsChange={noop}
            actionPending={false}
            structurePending={false}
            onAction={noop}
            onOpenHref={noop}
            onManageTags={noop}
            onMergeConversation={noop}
            onReassignMessage={noop}
            automationTrace={[]}
            onUndoAutomation={noop}
            onAssignConversation={noop}
            onAssignConversationToMe={noop}
            assignment={null}
            workStatus={null}
            completionPending={false}
            onSetCompletion={noop}
            respondRequest={null}
            onRespondRequestHandled={noop}
            onSplitMessage={noop}
            onKeep={noop}
            onStopKeeping={noop}
            onSummarySaved={async () => {}}
            onReconcile={async () => {}}
            onReconcileAfterWrite={async () => {}}
            onClose={noop}
          />
        </div>
      </LocaleProvider>
    ),
    host,
  );
};
