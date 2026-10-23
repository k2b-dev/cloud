import type { DateContext } from "@k2b/stdlib";
import type { PanesLayout } from "@k2b/ui";
import { ButtonLink, Placeholder, useLocale } from "@k2b/ui";
import { createSignal, onMount, Show } from "solid-js";
import type { MailContactDirectory } from "../../contact-directory-settings";
import type { MailDraftSeed, SenderIdentity } from "../../contracts";
import MailComposerPage from "./MailComposerPage";
import { mailComposerMessages } from "./mail-composer-messages";
import type { MailComposerSignatures } from "./mail-composer-signature";
import { readMailDraftSeed } from "./mail-draft-seed-store";
import { openMailUserDraftStorage } from "./mail-user-draft-storage";

export default function MailDraftSeedComposerPage(props: {
  mailboxId: string;
  mailboxRecipientSuggestions?: boolean;
  currentActor: { kind: "user" | "service_account"; id: string };
  seedId: string;
  identities: SenderIdentity[];
  signatures: MailComposerSignatures;
  initialPanes: PanesLayout;
  returnHref: string;
  popout?: boolean;
  dateConfig: DateContext;
  canShareAttachments: boolean;
  canManageMailbox: boolean;
  currentUserEmail: string | null;
  calendarIntegrationAvailable: boolean;
  contactDirectory: MailContactDirectory;
}) {
  const locale = useLocale();
  const t = () => mailComposerMessages.resolve([locale()]).t;
  const [seed, setSeed] = createSignal<MailDraftSeed | null>();

  onMount(() => {
    try {
      setSeed(
        props.currentActor.kind === "user"
          ? readMailDraftSeed(openMailUserDraftStorage(localStorage, props.currentActor.id), props.mailboxId, props.seedId)
          : null,
      );
    } catch {
      setSeed(null);
    }
  });

  return (
    <Show
      when={seed() !== undefined}
      fallback={<Placeholder state="loading" variant="panel" class="h-full" title={t().preparingMessage} />}
    >
      <Show
        when={seed()}
        fallback={
          <div class="flex h-full items-center justify-center p-6">
            <Placeholder
              state="error"
              title={t().temporaryMessageUnavailable}
              description={t().temporaryMessageDescription}
              action={
                <ButtonLink variant="secondary" size="sm" href={props.returnHref}>
                  {t().backToMailbox}
                </ButtonLink>
              }
            />
          </div>
        }
      >
        {(value) => (
          <MailComposerPage
            mailboxId={props.mailboxId}
            mailboxRecipientSuggestions={props.mailboxRecipientSuggestions}
            currentActor={props.currentActor}
            identities={props.identities}
            signatures={props.signatures}
            initialSeed={value()}
            initialPanes={props.initialPanes}
            returnHref={props.returnHref}
            popout={props.popout}
            dateConfig={props.dateConfig}
            canShareAttachments={props.canShareAttachments}
            canManageMailbox={props.canManageMailbox}
            currentUserEmail={props.currentUserEmail}
            contactDirectory={props.contactDirectory}
            calendarIntegrationAvailable={props.calendarIntegrationAvailable}
          />
        )}
      </Show>
    </Show>
  );
}
