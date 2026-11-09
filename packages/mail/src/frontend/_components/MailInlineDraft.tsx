import type { DateContext } from "@k2b/stdlib";
import { Button, Placeholder, useLocale } from "@k2b/ui";
import { createResource, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { MailDraft, SenderIdentity } from "../../contracts";
import { readApiError } from "./api-response";
import type { MailComposerHost } from "./MailComposer";
import type { UnfinishedDraftUpload } from "./mail-composer-attachment-manager";
import { mailComposerMessages } from "./mail-composer-messages";
import { createDefaultMailComposerPanesLayout } from "./mail-composer-panes";
import type { MailComposerSignatures } from "./mail-composer-signature";

type InlineDraftData = {
  draft: MailDraft;
  uploads: UnfinishedDraftUpload[];
  signatures: MailComposerSignatures;
  Composer: typeof import("./MailComposer").default;
};

/**
 * A draft inside its conversation. It loads what the compose page loads on the server (the draft, its unfinished
 * uploads, the signatures), then shows the same composer. Until then a placeholder holds the draft's place, so nothing
 * below it moves when the editor appears; a failed load stays here with Retry.
 */
export default function MailInlineDraft(props: {
  mailboxId: string;
  draftId: string;
  /** The draft as this click created it; it skips loading the draft once more. */
  initialDraft?: MailDraft;
  host: MailComposerHost;
  currentUserId: string;
  currentUserEmail: string | null;
  identities: SenderIdentity[];
  dateConfig: DateContext;
  canAdmin: boolean;
  mailboxRecipientSuggestions: boolean;
  calendarIntegrationAvailable: boolean;
  liveDictation: boolean;
  returnHref: string;
}) {
  const locale = useLocale();
  const t = () => mailComposerMessages.resolve([locale()]).t;
  const load = async (draftId: string): Promise<InlineDraftData> => {
    const param = { mailboxId: props.mailboxId };
    // The composer and its contracts load with the draft, not with the mailbox: most visits never write.
    const [composer, draftResponse, uploadsResponse, templatesResponse, defaultsResponse] = await Promise.all([
      import("./MailComposer"),
      props.initialDraft?.id === draftId
        ? null
        : apiClient.mailboxes[":mailboxId"].drafts[":draftId"].$get({ param: { ...param, draftId } }),
      apiClient.mailboxes[":mailboxId"].drafts[":draftId"]["attachment-uploads"].$get({ param: { ...param, draftId } }),
      apiClient.mailboxes[":mailboxId"]["compose-templates"].$get({ param }),
      apiClient.mailboxes[":mailboxId"]["compose-signature-defaults"].$get({ param }),
    ]);
    if (draftResponse && !draftResponse.ok) throw new Error(await readApiError(draftResponse, t().draftCouldNotBeSaved));
    const draft = draftResponse ? await draftResponse.json() : props.initialDraft!;
    // Uploads and signatures make the draft complete, but a draft without them is still safe to edit.
    const uploads = uploadsResponse.ok ? await uploadsResponse.json() : [];
    const templates = templatesResponse.ok ? await templatesResponse.json() : [];
    const defaults = defaultsResponse.ok ? await defaultsResponse.json() : [];
    return {
      Composer: composer.default,
      draft,
      uploads: uploads.map(({ id, filename, byteLength, receivedBytes }) => ({ id, filename, byteLength, receivedBytes })),
      signatures: {
        templates: templates.filter((template) => template.kind === "signature").map(({ id, name }) => ({ id, name })),
        personalDefaults: defaults
          .filter((entry) => entry.userId !== null)
          .map(({ senderIdentityId, templateId }) => ({ senderIdentityId, templateId })),
      },
    };
  };
  // The server renders the placeholder; the browser loads the draft with the person's session, after hydration.
  const [data, { refetch }] = createResource(() => (typeof window === "undefined" ? false : props.draftId), load);
  return (
    <Show
      when={data.state === "ready" ? data() : undefined}
      keyed
      fallback={
        <div class="mail-inline-draft mail-inline-draft-pending" data-mail-inline-draft-pending>
          <Placeholder
            state={data.error ? "error" : "loading"}
            variant="panel"
            title={data.error ? t().editorFailed : t().preparingDraft}
            description={data.error instanceof Error ? data.error.message : undefined}
            action={
              data.error ? (
                <Button variant="secondary" size="sm" type="button" onClick={() => void refetch()}>
                  {t().retry}
                </Button>
              ) : undefined
            }
          />
        </div>
      }
    >
      {(loaded) => (
        <loaded.Composer
          host={props.host}
          mailboxId={props.mailboxId}
          mailboxRecipientSuggestions={props.mailboxRecipientSuggestions}
          currentActor={{ kind: "user", id: props.currentUserId }}
          identities={props.identities}
          signatures={loaded.signatures}
          initialDraft={loaded.draft}
          unfinishedUploads={loaded.uploads}
          initialPanes={createDefaultMailComposerPanesLayout()}
          returnHref={props.returnHref}
          dateConfig={props.dateConfig}
          canShareAttachments={props.canAdmin}
          canManageMailbox={props.canAdmin}
          currentUserEmail={props.currentUserEmail}
          calendarIntegrationAvailable={props.calendarIntegrationAvailable}
          liveDictation={props.liveDictation}
        />
      )}
    </Show>
  );
}
