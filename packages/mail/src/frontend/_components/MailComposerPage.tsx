import { Approvals } from "@k2b/cloud/approvals/ui";
import type { ApprovalPage } from "@k2b/cloud/contracts/approvals";
import type { DateContext } from "@k2b/stdlib";
import type { PanesLayout } from "@k2b/ui";
import type { MailContactDirectory } from "../../contact-directory-settings";
import type { MailDraft, MailDraftSeed, SenderIdentity } from "../../contracts";
import MailComposer from "./MailComposer";
import type { UnfinishedDraftUpload } from "./mail-composer-attachment-manager";
import type { MailComposerSignatures } from "./mail-composer-signature";
import { MailContactDirectoryProvider } from "./mail-contact-directory-context";

export default function MailComposerPage(props: {
  mailboxId: string;
  currentActor: { kind: "user" | "service_account"; id: string };
  identities: SenderIdentity[];
  signatures: MailComposerSignatures;
  initialDraft?: MailDraft;
  initialSeed?: MailDraftSeed;
  unfinishedUploads?: UnfinishedDraftUpload[];
  initialPanes: PanesLayout;
  returnHref: string;
  popout?: boolean;
  dateConfig: DateContext;
  canShareAttachments: boolean;
  canManageMailbox: boolean;
  currentUserEmail: string | null;
  calendarIntegrationAvailable: boolean;
  contactDirectory: MailContactDirectory;
  /** Open approvals whose review links to this draft, such as sending it; rendered with the page so they never push it down. */
  approvals?: { link: string; page: ApprovalPage };
}) {
  return (
    <div class="flex h-full min-h-0 flex-col gap-2 overflow-hidden">
      {props.approvals && <Approvals app="mail" link={props.approvals.link} initial={props.approvals.page} layout="band" />}
      <div class="flex min-h-0 flex-1 flex-col overflow-hidden" classList={{ "paper rounded-[var(--ui-radius-frame)]": !props.popout }}>
        <MailContactDirectoryProvider value={props.contactDirectory}>
          <MailComposer
            mailboxId={props.mailboxId}
            currentActor={props.currentActor}
            identities={props.identities}
            signatures={props.signatures}
            initialDraft={props.initialDraft}
            initialSeed={props.initialSeed}
            unfinishedUploads={props.unfinishedUploads}
            initialPanes={props.initialPanes}
            popout={props.popout}
            returnHref={props.returnHref}
            dateConfig={props.dateConfig}
            canShareAttachments={props.canShareAttachments}
            canManageMailbox={props.canManageMailbox}
            currentUserEmail={props.currentUserEmail}
            calendarIntegrationAvailable={props.calendarIntegrationAvailable}
          />
        </MailContactDirectoryProvider>
      </div>
    </div>
  );
}
