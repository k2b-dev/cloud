import { DetailPanel, LocaleProvider } from "@k2b/ui";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { DEFAULT_MAIL_CONTACT_DIRECTORY, type MailContactDirectory } from "../../contact-directory";
import MailConversationContext from "./MailConversationContext";
import MailRecipientInput from "./MailRecipientInput";
import { MailContactDirectoryProvider } from "./mail-contact-directory-context";

export type MailRecipientHarnessOptions = {
  locale: "en" | "de";
  /** Whether a contact directory app is registered; without one every directory function is unmapped. */
  contacts: boolean;
};

declare global {
  interface Window {
    mountMailRecipients: (options: MailRecipientHarnessOptions) => void;
  }
}

const absentDirectory: MailContactDirectory = { suggest: null, resolve: null, read: null, listWritableBooks: null, create: null };

/** Fixture text for the surrounding page, which the real pages take from their own catalogs. */
const fixtureText = {
  en: { subject: "Quarterly review", contextGroup: "Conversation context" },
  de: { subject: "Quarterly review", contextGroup: "Unterhaltungskontext" },
};

/** The composer's To row beside the conversation's details panel, as the compose and mailbox pages arrange them. */
window.mountMailRecipients = (options) => {
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing harness root");
  document.documentElement.lang = options.locale;
  const [to, setTo] = createSignal<string[]>([]);
  render(
    () => (
      <LocaleProvider locale={options.locale}>
        <MailContactDirectoryProvider value={options.contacts ? DEFAULT_MAIL_CONTACT_DIRECTORY : absentDirectory}>
          <div class="flex min-h-0 w-full flex-col gap-4 bg-[var(--ui-canvas)] p-4 md:flex-row">
            <section class="min-w-0 flex-1" data-testid="composer">
              <div class="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] items-center gap-2 text-sm">
                <span class="text-dimmed">{options.locale === "de" ? "An" : "To"}</span>
                <MailRecipientInput
                  mailboxId="Box001"
                  placeholder={options.locale === "de" ? "Empfänger" : "Recipients"}
                  value={to}
                  onChange={setTo}
                />
              </div>
            </section>
            <aside class="w-full shrink-0 md:w-[22rem]" data-testid="details">
              <DetailPanel>
                <DetailPanel.Header title={fixtureText[options.locale].subject} />
                <DetailPanel.Body>
                  <DetailPanel.Group label={fixtureText[options.locale].contextGroup}>
                    <MailConversationContext mailboxId="Box001" conversationId="Conv01" requestUrl="/app/mail/Box001" active />
                  </DetailPanel.Group>
                </DetailPanel.Body>
              </DetailPanel>
            </aside>
          </div>
        </MailContactDirectoryProvider>
      </LocaleProvider>
    ),
    host,
  );
};
