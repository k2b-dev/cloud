import { createSignal, mergeProps, Show } from "solid-js";
import type { MailDraft } from "../contracts";
import { MailCloudIdProvider } from "./_components/mail-cloud-id";
import { openInMailbox } from "./_components/mail-compose-intent-state";
import { openDraftWindow } from "./_components/mail-compose-windows";
import { MailContactDirectoryProvider } from "./_components/mail-contact-directory-context";
import { MailComposeDialogV2 } from "./_components/v2/MailComposeDialogV2";
import MailWorkspaceV2, { createMailV2Dom } from "./_components/v2/MailWorkspaceV2";
import { createMailboxSessions, MailboxComposeWindows, type MailWorkspaceProps, useMailboxController } from "./mail-workspace";

/**
 * Mail's mailbox page on the @k2b/ui v2 pilot (provisional, `mail.ui_v2_pilot`): the same sessions, controller, live
 * updates and actions as v1, drawn with v2. Its own island, so the v1 page loads none of it.
 */
export default function MailWorkspacePilot(props: MailWorkspaceProps) {
  const { mailboxPreferences, session, setControls, switching, cancelSwitch, switchMailbox } = createMailboxSessions(props);
  const v2 = createMailV2Dom();
  const workspace = {
    get session() {
      return session();
    },
    switching,
    onReady: setControls,
    onNavigationStart: cancelSwitch,
    onOpenMailboxHistory: (url: URL, completeScrollRestore: () => void) => {
      void switchMailbox(url, undefined, completeScrollRestore);
    },
    dom: v2.dom,
  };
  // mergeProps keeps the session a getter, so a mailbox switch reaches the controller.
  const controller = useMailboxController(mergeProps(props, workspace));
  // New message's dialog, which the URL asked for (`?compose=1`): closing it leaves the mailbox as it is
  const [compose, setCompose] = createSignal(props.compose);
  const closeCompose = () => {
    setCompose(undefined);
    controller().closeCompose();
  };
  // a draft of this mailbox opens as its window here, as New message in the mailbox; one of another mailbox opens there
  const openComposed = (draft: MailDraft) => {
    if (draft.mailboxId !== controller().data.mailbox.id) return openInMailbox(draft);
    closeCompose();
    openDraftWindow(draft.id, { mailboxId: draft.mailboxId, initialDraft: draft, fresh: draft.creationOutcome === "created" });
  };

  return (
    <MailContactDirectoryProvider value={props.contactDirectory}>
      <MailCloudIdProvider cloudUrl={props.cloudUrl}>
        <MailWorkspaceV2
          controller={controller}
          dateConfig={props.dateConfig}
          shell={{
            mailboxes: props.sidebar.mailboxes,
            preferences: mailboxPreferences,
            rows: v2.rows,
            openMailbox: (nav) => switchMailbox(nav.url, nav),
          }}
          session={{
            currentUserId: props.currentUserId,
            currentUserEmail: props.currentUserEmail,
            calendarIntegrationAvailable: props.calendarIntegrationAvailable,
            liveDictation: props.liveDictation ?? false,
          }}
        />
        <MailboxComposeWindows {...props} {...workspace} controller={controller} area="[data-k2-workspace]" />
        <Show when={compose()}>{(intent) => <MailComposeDialogV2 {...intent()} open={openComposed} onClose={closeCompose} />}</Show>
      </MailCloudIdProvider>
    </MailContactDirectoryProvider>
  );
}
