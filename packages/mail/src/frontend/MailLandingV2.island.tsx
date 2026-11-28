import { useLocale } from "@k2b/ui";
import { Empty, Failed, Nav, Pane, Workspace } from "@k2b/ui/v2";
import { createMemo, Show } from "solid-js";
import { createMailboxCreation, type MailboxCreationContext } from "./_components/create-mailbox-dialog";
import { MailContactDirectoryProvider } from "./_components/mail-contact-directory-context";
import { mailOverviewMessages } from "./mail-overview-messages";

/**
 * `/app/mail` on UI v2 when it opens no mailbox: the person has none yet, or Mail could not read them. Every other
 * visit goes straight to a mailbox on the server. One sentence and one way out, in the place the list would take.
 */
function MailLandingV2View(
  props: MailboxCreationContext & {
    error: string | null;
    /** The requested path and query, so Retry asks for the same view or link again. */
    retryHref: string;
  },
) {
  const locale = useLocale();
  const messages = createMemo(() => mailOverviewMessages.resolve([locale()]).t);
  const createMailbox = createMailboxCreation(props, messages);
  return (
    <Workspace sidebar={<Nav title="Mail" icon="mail" groups={[]} />}>
      <Pane label="Mail">
        {/* After a failed read the page would claim there is no mailbox, so only the error and its way out show. */}
        <Show
          when={props.error}
          fallback={
            <Empty
              icon="mail-plus"
              text={messages().noMailboxYetDescription}
              action={{
                label: createMailbox.loading() ? messages().creatingMailbox : messages().newMailbox,
                icon: "mail-plus",
                disabled: createMailbox.loading(),
                onClick: () => createMailbox.mutate(),
              }}
            />
          }
        >
          {(error) => (
            <Failed text={`${messages().couldNotOpenMail}. ${error()}`} onRetry={() => window.location.assign(props.retryHref)} />
          )}
        </Show>
      </Pane>
    </Workspace>
  );
}

export default function MailLandingV2(props: Parameters<typeof MailLandingV2View>[0]) {
  return (
    <MailContactDirectoryProvider value={props.contactDirectory}>
      <MailLandingV2View {...props} />
    </MailContactDirectoryProvider>
  );
}
