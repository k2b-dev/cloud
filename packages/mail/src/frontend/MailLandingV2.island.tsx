import { V2WorkspaceNavigation } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import { Bar, Empty, Failed, Nav, Pane, Path, Workspace } from "@k2b/ui/v2";
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
  const create = () => ({
    label: createMailbox.loading() ? messages().creatingMailbox : messages().newMailbox,
    icon: "mail-plus",
    disabled: createMailbox.loading(),
    onClick: () => createMailbox.mutate(),
  });
  // The sidebar and the head as on a mailbox page: the group of mailboxes with its deed, the place in the head. After a
  // failed read the group would claim there is none, so it shows only while the list is known to be empty.
  const groups = () => (props.error ? [] : [{ label: messages().mailboxes, action: { ...create(), icon: "plus" }, items: [] }]);
  return (
    <>
      {/* on the phone the shell's bar carries the same navigation, as on a mailbox page */}
      <V2WorkspaceNavigation label="Mail" groups={groups()} />
      <Workspace
        sidebar={<Nav title="Mail" icon="mail" groups={groups()} />}
        head={<Bar start={<Path label="Mail" items={[{ label: messages().mailboxes }]} />} />}
      >
        <Pane label={messages().mailboxes}>
          {/* After a failed read the page would claim there is no mailbox, so only the error and its way out show. */}
          <Show when={props.error} fallback={<Empty icon="mail-plus" text={messages().noMailboxYetDescription} action={create()} />}>
            {(error) => (
              <Failed text={`${messages().couldNotOpenMail}. ${error()}`} onRetry={() => window.location.assign(props.retryHref)} />
            )}
          </Show>
        </Pane>
      </Workspace>
    </>
  );
}

export default function MailLandingV2(props: Parameters<typeof MailLandingV2View>[0]) {
  return (
    <MailContactDirectoryProvider value={props.contactDirectory}>
      <MailLandingV2View {...props} />
    </MailContactDirectoryProvider>
  );
}
