import type { DateContext } from "@k2b/stdlib";
import type { PanesLayout } from "@k2b/ui";
import { ButtonLink, Placeholder, useLocale } from "@k2b/ui";
import { createSignal, onMount, Show } from "solid-js";
import type { MailDraftSeed, SenderIdentity } from "../../contracts";
import MailComposerPage from "./MailComposerPage.island";
import { mailComposerMessages } from "./mail-composer-messages";
import { readMailDraftSeed } from "./mail-draft-seed-store";

export default function MailDraftSeedComposerPage(props: {
  mailboxId: string;
  currentActor: { kind: "user" | "service_account"; id: string };
  seedId: string;
  identities: SenderIdentity[];
  initialPanes: PanesLayout;
  returnHref: string;
  popout?: boolean;
  dateConfig: DateContext;
  canShareAttachments: boolean;
  calendarIntegrationAvailable: boolean;
}) {
  const locale = useLocale();
  const t = () => mailComposerMessages.resolve([locale()]).t;
  const [seed, setSeed] = createSignal<MailDraftSeed | null>();

  onMount(() => setSeed(readMailDraftSeed(localStorage, props.mailboxId, props.seedId)));

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
            currentActor={props.currentActor}
            identities={props.identities}
            initialSeed={value()}
            initialPanes={props.initialPanes}
            returnHref={props.returnHref}
            popout={props.popout}
            dateConfig={props.dateConfig}
            canShareAttachments={props.canShareAttachments}
            calendarIntegrationAvailable={props.calendarIntegrationAvailable}
          />
        )}
      </Show>
    </Show>
  );
}
