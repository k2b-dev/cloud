import { AppWorkspace, Button, ButtonLink, Placeholder, useLocale } from "@k2b/ui";
import { createMemo, Show } from "solid-js";
import { createMailboxCreation, type MailboxCreationContext } from "./_components/create-mailbox-dialog";
import MailSidebar from "./_components/MailSidebar";
import { MailContactDirectoryProvider } from "./_components/mail-contact-directory-context";
import { createMailboxPreferences } from "./_components/mail-mailbox-preferences";
import { mailOverviewMessages } from "./mail-overview-messages";

/**
 * `/app/mail` when it opens no mailbox: the person has none yet, or Mail could not read them. Every other visit
 * goes straight to a mailbox on the server.
 */
function MailLandingView(
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
    <AppWorkspace mobileSurface="flush" flat class="mail-landing-workspace">
      <h1 class="sr-only">Mail</h1>
      {/* After a failed read the list would claim there is no mailbox, so only the error and its way out show. */}
      <Show when={!props.error}>
        <MailSidebar
          currentUserEmail={props.currentUserEmail}
          contactDirectory={props.contactDirectory}
          mailboxes={[]}
          preferences={createMailboxPreferences({ pinnedMailboxIds: [], hiddenMailboxIds: [] })}
          counts={[]}
          canCreate
          open={null}
          mobile="stacked"
        />
      </Show>
      <AppWorkspace.Content>
        <AppWorkspace.Main class="mail-landing-main" width="content">
          <Show
            when={props.error}
            fallback={
              <Placeholder
                title={messages().noMailboxYet}
                description={messages().noMailboxYetDescription}
                icon="ti ti-mail-plus"
                class="min-h-56"
                action={
                  <Button
                    size="sm"
                    loading={createMailbox.loading()}
                    loadingLabel={messages().creatingMailbox}
                    onClick={() => createMailbox.mutate()}
                  >
                    <i class="ti ti-mail-plus" aria-hidden="true" /> {messages().newMailbox}
                  </Button>
                }
              />
            }
          >
            {(error) => (
              <Placeholder
                state="error"
                title={messages().couldNotOpenMail}
                description={error()}
                class="min-h-56"
                action={
                  <ButtonLink variant="secondary" size="sm" href={props.retryHref}>
                    <i class="ti ti-refresh" aria-hidden="true" /> {messages().retry}
                  </ButtonLink>
                }
              />
            )}
          </Show>
        </AppWorkspace.Main>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}

export default function MailLanding(props: Parameters<typeof MailLandingView>[0]) {
  return (
    <MailContactDirectoryProvider value={props.contactDirectory}>
      <MailLandingView {...props} />
    </MailContactDirectoryProvider>
  );
}
