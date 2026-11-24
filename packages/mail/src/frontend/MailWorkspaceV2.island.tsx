import { mergeProps } from "solid-js";
import { MailCloudIdProvider } from "./_components/mail-cloud-id";
import { MailContactDirectoryProvider } from "./_components/mail-contact-directory-context";
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
      </MailCloudIdProvider>
    </MailContactDirectoryProvider>
  );
}
