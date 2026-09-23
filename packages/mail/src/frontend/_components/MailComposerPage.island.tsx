import type { DateContext } from "@k2b/stdlib";
import type { PanesLayout } from "@k2b/ui";
import type { MailContactDirectory } from "../../contact-directory-settings";
import type { MailDraft, MailDraftSeed, SenderIdentity } from "../../contracts";
import MailComposer from "./MailComposer";
import { MailContactDirectoryProvider } from "./mail-contact-directory-context";

export default function MailComposerPage(props: {
  mailboxId: string;
  currentActor: { kind: "user" | "service_account"; id: string };
  identities: SenderIdentity[];
  initialDraft?: MailDraft;
  initialSeed?: MailDraftSeed;
  initialPanes: PanesLayout;
  returnHref: string;
  popout?: boolean;
  dateConfig: DateContext;
  canShareAttachments: boolean;
  calendarIntegrationAvailable: boolean;
  contactDirectory: MailContactDirectory;
}) {
  return (
    <div class="flex h-full min-h-0 flex-col overflow-hidden">
      <div class="flex min-h-0 flex-1 flex-col overflow-hidden" classList={{ "paper rounded-[var(--ui-radius-frame)]": !props.popout }}>
        <MailContactDirectoryProvider value={props.contactDirectory}>
          <MailComposer
            mailboxId={props.mailboxId}
            currentActor={props.currentActor}
            identities={props.identities}
            initialDraft={props.initialDraft}
            initialSeed={props.initialSeed}
            initialPanes={props.initialPanes}
            popout={props.popout}
            returnHref={props.returnHref}
            dateConfig={props.dateConfig}
            canShareAttachments={props.canShareAttachments}
            calendarIntegrationAvailable={props.calendarIntegrationAvailable}
          />
        </MailContactDirectoryProvider>
      </div>
    </div>
  );
}
