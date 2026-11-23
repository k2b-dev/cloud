import { AppWorkspace } from "@k2b/ui";
import MailSidebar from "./_components/MailSidebar";
import { MailCloudIdProvider } from "./_components/mail-cloud-id";
import { MailContactDirectoryProvider } from "./_components/mail-contact-directory-context";
import { createMailboxSessions, MailboxWorkspace, type MailWorkspaceProps } from "./mail-workspace";

/** Mail's mailbox page: the sidebar of mailboxes and the open mailbox's workspace. */
export default function MailWorkspace(props: MailWorkspaceProps) {
  const { mailboxPreferences, session, controls, setControls, switching, cancelSwitch, switchMailbox } = createMailboxSessions(props);

  return (
    <MailContactDirectoryProvider value={props.contactDirectory}>
      <MailCloudIdProvider cloudUrl={props.cloudUrl}>
        <AppWorkspace mobileSurface="flush" class="mail-workspace">
          {(() => {
            // Resolve the session before the sidebar, so its first server and browser render already has the open mailbox.
            const workspace = (
              <MailboxWorkspace
                {...props}
                session={session()}
                switching={switching}
                onReady={setControls}
                onNavigationStart={cancelSwitch}
                onOpenMailboxHistory={(url, completeScrollRestore) => {
                  void switchMailbox(url, undefined, completeScrollRestore);
                }}
              />
            );
            return (
              <>
                <MailSidebar
                  canCreate={Boolean(props.currentUserId)}
                  currentUserEmail={props.currentUserEmail}
                  contactDirectory={props.contactDirectory}
                  mailboxes={props.sidebar.mailboxes}
                  preferences={mailboxPreferences}
                  counts={[]}
                  focusNoticeOpen={props.sidebar.focusNoticeOpen}
                  open={controls()?.open() ?? null}
                  onOpenPlaceRowHiddenChange={(hidden) => controls()?.onOpenPlaceRowHiddenChange(hidden)}
                  onOpenMailbox={(nav) => switchMailbox(new URL(nav.href, window.location.origin), nav)}
                />
                {workspace}
              </>
            );
          })()}
        </AppWorkspace>
      </MailCloudIdProvider>
    </MailContactDirectoryProvider>
  );
}
